/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { handleServerError } from '@/lib/handle-server-error'

import { sendChatCompletion } from '../api'
import { ERROR_MESSAGES, MESSAGE_STATUS } from '../constants'
import {
  applyStreamingChunk,
  applyToolCallDelta,
  attachMessageVersionUsage,
  buildChatCompletionPayload,
  ensurePlaygroundDocumentTexts,
  ensurePlaygroundMessageAttachments,
  getCurrentVersion,
  MESSAGE_FINISH_REASON,
  setCurrentVersionFinishReason,
  toMessageUsage,
  updateAssistantMessageWithError,
  updateCurrentVersionContent,
  updateLastAssistantMessage,
  parseRequestErrorDetails,
  applyChatCompletionResponse,
  completeAssistantMessage,
  hasChatCompletionChoice,
  isAssistantMessageFinal,
  isAssistantMessagePending,
} from '../lib'
import type { PlaygroundCapturedRequest, ToolCallDelta } from '../lib'
import type {
  Message,
  MessageUsage,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  PlaygroundPendingQuote,
  ParameterEnabled,
} from '../types'
import { useStreamRequest } from './use-stream-request'

interface UseChatHandlerOptions {
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  /** Conversation-level instruction injected as the first request message. */
  systemPrompt: string
  /** Enabled cross-session memory block injected after the system prompt. */
  memoryBlock?: string
  /** Context limits and summary model applied when the payload is built. */
  contextSettings: PlaygroundContextSettings
  /**
   * Resolves the compression node the send should carry, summarizing the
   * messages a limit leaves out first when automatic summary is enabled. The
   * callback never rejects for a failed summarization; it falls back to the
   * current node so the message itself is not blocked.
   */
  prepareContextSummary?: (
    messages: Message[]
  ) => Promise<PlaygroundContextSummary | null>
  /**
   * Retrieves knowledge-base context for the newest user turn and returns the
   * messages with the snapshot attached. A failure is expected to resolve with
   * the original messages so a turn still sends without knowledge context.
   */
  prepareKnowledge?: (messages: Message[]) => Promise<Message[]>
  onMessageUpdate: (
    updater: (prev: Message[]) => Message[],
    sessionId?: string | null
  ) => void
  /**
   * A reply that finished generating successfully. The workspace uses it for
   * side effects that must not block the next input, like automatic
   * read-aloud; failures and user stops are not reported here.
   */
  onResponseComplete?: (result: {
    messageKey: string
    versionId: string
    content: string
    finishReason?: string
  }) => void
  sessionId: string | null
}

const KNOWN_ERROR_MESSAGES = new Set<string>(Object.values(ERROR_MESSAGES))
const STREAM_UPDATE_FLUSH_MS = 50

type PendingStreamChunks = {
  generation: number
  content: string
  reasoning: string
  toolCalls: ToolCallDelta[]
}

function mergePendingStreamChunk(
  currentChunk: string,
  nextChunk: string
): string {
  if (!currentChunk || !nextChunk.startsWith(currentChunk)) {
    return currentChunk + nextChunk
  }

  return nextChunk
}

/**
 * Hook for handling chat message sending and receiving
 */
export function useChatHandler({
  config,
  parameterEnabled,
  systemPrompt,
  memoryBlock,
  contextSettings,
  prepareContextSummary,
  prepareKnowledge,
  onMessageUpdate,
  onResponseComplete,
  sessionId,
}: UseChatHandlerOptions) {
  const { t } = useTranslation()
  const { sendStreamRequest, stopStream, isStreaming } = useStreamRequest()
  const [isRequesting, setIsRequesting] = useState(false)
  // Final payload of the most recent send, kept in memory only for the request
  // viewer. Nothing is persisted and a reload clears it.
  const [capturedRequest, setCapturedRequest] =
    useState<PlaygroundCapturedRequest | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const requestGenerationRef = useRef(0)
  const pendingStreamChunksRef = useRef<PendingStreamChunks>({
    generation: 0,
    content: '',
    reasoning: '',
    toolCalls: [],
  })
  const streamFlushTimerRef = useRef<number | null>(null)
  const requestSessionIdRef = useRef<string | null>(sessionId)
  // Generation record captured while the stream runs; it is attached to the
  // finished message so the conversation can show usage and look up the cost.
  const pendingRequestIdRef = useRef<string | null>(null)
  const pendingUsageRef = useRef<MessageUsage | null>(null)
  // Provider finish reason of the final stream frame (for example `length`).
  const pendingFinishReasonRef = useRef<string | null>(null)
  // One continuation in flight: the prefill form is tried first and a channel
  // that rejects it retries once with a user continue instruction. The pending
  // record travels with that retry so an ordinary request is never rerouted.
  const continuationRef = useRef<{
    fallbackMessages: Message[]
    contextSummary: PlaygroundContextSummary | null
    prefix: string
  } | null>(null)
  // Deliver a prepared payload through the configured transport. It is a ref
  // so the stream error handler can start the continuation fallback without a
  // circular hook dependency.
  const deliverPayloadRef = useRef<
    (
      messages: Message[],
      summary: PlaygroundContextSummary | null,
      prefix?: string
    ) => void
  >(() => undefined)

  const discardPendingStreamUpdates = useCallback((generation: number) => {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
    pendingStreamChunksRef.current = {
      generation,
      content: '',
      reasoning: '',
      toolCalls: [],
    }
  }, [])

  const flushStreamUpdates = useCallback(
    (generation: number) => {
      if (generation !== requestGenerationRef.current) return
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current)
        streamFlushTimerRef.current = null
      }

      const pendingChunks = pendingStreamChunksRef.current
      if (pendingChunks.generation !== generation) return
      if (
        !pendingChunks.reasoning &&
        !pendingChunks.content &&
        pendingChunks.toolCalls.length === 0
      ) {
        return
      }

      pendingStreamChunksRef.current = {
        generation,
        content: '',
        reasoning: '',
        toolCalls: [],
      }
      onMessageUpdate((prev) => {
        if (generation !== requestGenerationRef.current) return prev
        return updateLastAssistantMessage(prev, (message) => {
          let updatedMessage = message

          if (pendingChunks.reasoning) {
            updatedMessage = applyStreamingChunk(
              updatedMessage,
              'reasoning',
              pendingChunks.reasoning
            )
          }

          if (pendingChunks.content) {
            updatedMessage = applyStreamingChunk(
              updatedMessage,
              'content',
              pendingChunks.content
            )
          }

          for (const delta of pendingChunks.toolCalls) {
            updatedMessage = applyToolCallDelta(updatedMessage, delta)
          }

          return updatedMessage
        })
      }, requestSessionIdRef.current)
    },
    [onMessageUpdate]
  )

  const scheduleStreamFlush = useCallback(
    (generation: number) => {
      if (generation !== requestGenerationRef.current) return
      if (streamFlushTimerRef.current !== null) {
        return
      }

      streamFlushTimerRef.current = window.setTimeout(() => {
        flushStreamUpdates(generation)
      }, STREAM_UPDATE_FLUSH_MS)
    },
    [flushStreamUpdates]
  )

  useEffect(
    () => () => {
      requestGenerationRef.current += 1
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current)
      }
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    },
    []
  )

  const getDisplayError = useCallback(
    (error: string) => {
      if (KNOWN_ERROR_MESSAGES.has(error)) {
        return t(error)
      }

      const connectionClosedSuffix = `: ${ERROR_MESSAGES.CONNECTION_CLOSED}`
      if (error.endsWith(connectionClosedSuffix)) {
        return `${error.slice(0, -ERROR_MESSAGES.CONNECTION_CLOSED.length)}${t(
          ERROR_MESSAGES.CONNECTION_CLOSED
        )}`
      }

      return error
    },
    [t]
  )

  // Handle stream update
  const handleStreamUpdate = useCallback(
    (generation: number, type: 'reasoning' | 'content', chunk: string) => {
      if (generation !== requestGenerationRef.current) return
      if (pendingStreamChunksRef.current.generation !== generation) return
      pendingStreamChunksRef.current[type] = mergePendingStreamChunk(
        pendingStreamChunksRef.current[type],
        chunk
      )
      scheduleStreamFlush(generation)
    },
    [scheduleStreamFlush]
  )

  // Handle streamed tool call fragments; they merge by stream index when the
  // buffered chunks are flushed into the message snapshot.
  const handleToolCallDeltas = useCallback(
    (generation: number, deltas: ToolCallDelta[]) => {
      if (generation !== requestGenerationRef.current) return
      if (pendingStreamChunksRef.current.generation !== generation) return
      pendingStreamChunksRef.current.toolCalls.push(...deltas)
      scheduleStreamFlush(generation)
    },
    [scheduleStreamFlush]
  )

  // The relay request id arrives with the response headers; it is kept until
  // the reply finishes so one lookup uses the settled consume row.
  const handleStreamRequestId = useCallback(
    (generation: number, requestId: string) => {
      if (generation !== requestGenerationRef.current) return
      pendingRequestIdRef.current = requestId
    },
    []
  )

  // The usage frame is the last chunk of the stream.
  const handleStreamUsage = useCallback(
    (generation: number, usage: MessageUsage) => {
      if (generation !== requestGenerationRef.current) return
      pendingUsageRef.current = usage
    },
    []
  )

  // The finish reason arrives with the final data frame; it labels the reply
  // so a truncated answer can offer "continue generation".
  const handleStreamFinishReason = useCallback(
    (generation: number, finishReason: string) => {
      if (generation !== requestGenerationRef.current) return
      pendingFinishReasonRef.current = finishReason
    },
    []
  )

  // Handle stream complete
  const handleStreamComplete = useCallback(
    (generation: number) => {
      if (generation !== requestGenerationRef.current) return
      flushStreamUpdates(generation)
      setIsRequesting(false)
      continuationRef.current = null
      const generationRecord = {
        requestId: pendingRequestIdRef.current ?? undefined,
        usage: pendingUsageRef.current ?? undefined,
      }
      const finishReason = pendingFinishReasonRef.current ?? undefined
      const completion: {
        result: {
          messageKey: string
          versionId: string
          content: string
          finishReason?: string
        } | null
      } = { result: null }
      onMessageUpdate((prev) => {
        if (generation !== requestGenerationRef.current) return prev
        return updateLastAssistantMessage(prev, (message) => {
          const completed = attachMessageVersionUsage(
            setCurrentVersionFinishReason(
              isAssistantMessageFinal(message)
                ? message
                : completeAssistantMessage(message),
              finishReason
            ),
            generationRecord
          )
          const version = getCurrentVersion(completed)
          completion.result = {
            messageKey: completed.key,
            versionId: version.id,
            content: version.content,
            finishReason: version.finishReason,
          }
          return completed
        })
      }, requestSessionIdRef.current)
      if (completion.result) onResponseComplete?.(completion.result)
    },
    [flushStreamUpdates, onMessageUpdate, onResponseComplete]
  )

  // Handle stream error
  const handleStreamError = useCallback(
    (generation: number, error: string, errorCode?: string) => {
      if (generation !== requestGenerationRef.current) return
      // A continuation prefers the assistant prefill form. When the channel
      // rejects it, retry once with one user continue instruction instead of
      // showing the failed prefill attempt as an error.
      const continuation = continuationRef.current
      if (continuation) {
        continuationRef.current = null
        flushStreamUpdates(generation)
        const fallbackGeneration = generation + 1
        requestGenerationRef.current = fallbackGeneration
        discardPendingStreamUpdates(fallbackGeneration)
        stopStream()
        abortControllerRef.current?.abort()
        abortControllerRef.current = null
        pendingRequestIdRef.current = null
        pendingUsageRef.current = null
        pendingFinishReasonRef.current = null
        setIsRequesting(false)
        // The prefill attempt may have produced a few chunks before the
        // channel rejected it. The user-instruction retry starts a fresh
        // answer, so the half-written branch is cleared first.
        onMessageUpdate(
          (prev) =>
            updateLastAssistantMessage(prev, (message) => ({
              ...updateCurrentVersionContent(message, continuation.prefix),
              startedAt: Date.now(),
              completedAt: undefined,
              durationMs: undefined,
              reasoning: undefined,
              isReasoningStreaming: false,
              isReasoningComplete: false,
              isContentComplete: false,
              status: MESSAGE_STATUS.LOADING,
              errorCode: null,
            })),
          requestSessionIdRef.current
        )
        deliverPayloadRef.current(
          continuation.fallbackMessages,
          continuation.contextSummary,
          continuation.prefix
        )
        return
      }
      flushStreamUpdates(generation)
      setIsRequesting(false)
      const displayError = getDisplayError(error)
      handleServerError(new Error(displayError))
      const errorTitle = t(ERROR_MESSAGES.API_REQUEST_ERROR)
      // A failed attempt can still be billed, so the recorded request id is
      // kept on the error message and its consume row stays visible.
      const requestId = pendingRequestIdRef.current
      onMessageUpdate((prev) => {
        if (generation !== requestGenerationRef.current) return prev
        const errored = updateAssistantMessageWithError(
          prev,
          displayError,
          errorCode,
          errorTitle
        )
        if (!requestId) return errored
        return updateLastAssistantMessage(errored, (message) =>
          attachMessageVersionUsage(message, { requestId })
        )
      }, requestSessionIdRef.current)
    },
    [
      flushStreamUpdates,
      discardPendingStreamUpdates,
      stopStream,
      getDisplayError,
      onMessageUpdate,
      t,
    ]
  )

  // Send streaming chat request
  const sendStreamingChat = useCallback(
    (
      messages: Message[],
      contextSummary: PlaygroundContextSummary | null,
      quote?: PlaygroundPendingQuote | null
    ) => {
      const generation = requestGenerationRef.current + 1
      requestGenerationRef.current = generation
      requestSessionIdRef.current = sessionId
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      pendingRequestIdRef.current = null
      pendingUsageRef.current = null
      pendingFinishReasonRef.current = null
      discardPendingStreamUpdates(generation)
      setIsRequesting(true)
      const payload = buildChatCompletionPayload(
        messages,
        config,
        parameterEnabled,
        systemPrompt,
        { settings: contextSettings, summary: contextSummary },
        memoryBlock,
        quote
      )
      setCapturedRequest({ payload, capturedAt: Date.now() })
      void sendStreamRequest(payload, {
        onUpdate: (type, chunk) => handleStreamUpdate(generation, type, chunk),
        onToolCalls: (deltas) => handleToolCallDeltas(generation, deltas),
        onRequestId: (requestId) =>
          handleStreamRequestId(generation, requestId),
        onUsage: (usage) => handleStreamUsage(generation, usage),
        onFinishReason: (finishReason) =>
          handleStreamFinishReason(generation, finishReason),
        onComplete: () => handleStreamComplete(generation),
        onError: (error, errorCode) =>
          handleStreamError(generation, error, errorCode),
      })
    },
    [
      config,
      parameterEnabled,
      systemPrompt,
      memoryBlock,
      contextSettings,
      sendStreamRequest,
      discardPendingStreamUpdates,
      handleStreamUpdate,
      handleToolCallDeltas,
      handleStreamRequestId,
      handleStreamUsage,
      handleStreamFinishReason,
      handleStreamComplete,
      handleStreamError,
      sessionId,
    ]
  )

  // Send non-streaming chat request
  const sendNonStreamingChat = useCallback(
    async (
      messages: Message[],
      contextSummary: PlaygroundContextSummary | null,
      /**
       * Text the continuation branch starts from. A complete answer replaces
       * the branch content, so a response that only carries the continuation
       * is prefixed with it.
       */
      prefix?: string,
      /** Composer quote carried by the next request; continuations send none. */
      quote?: PlaygroundPendingQuote | null
    ) => {
      const payload = buildChatCompletionPayload(
        messages,
        config,
        parameterEnabled,
        systemPrompt,
        { settings: contextSettings, summary: contextSummary },
        memoryBlock,
        quote
      )
      setCapturedRequest({ payload, capturedAt: Date.now() })
      const generation = requestGenerationRef.current + 1
      const abortController = new AbortController()

      requestGenerationRef.current = generation
      requestSessionIdRef.current = sessionId
      stopStream()
      pendingRequestIdRef.current = null
      pendingUsageRef.current = null
      pendingFinishReasonRef.current = null
      discardPendingStreamUpdates(generation)
      abortControllerRef.current?.abort()
      abortControllerRef.current = abortController

      try {
        setIsRequesting(true)
        const { response, requestId } = await sendChatCompletion(
          payload,
          abortController.signal
        )
        if (
          abortController.signal.aborted ||
          requestGenerationRef.current !== generation
        ) {
          return
        }

        // The failed-attempt path below reads the pending record, so the
        // request id stays attached even when the response is unusable.
        pendingRequestIdRef.current = requestId ?? null

        if (!hasChatCompletionChoice(response)) {
          handleStreamError(generation, ERROR_MESSAGES.API_REQUEST_ERROR)
          return
        }

        const usage = toMessageUsage(response.usage)
        const completion: {
          result: {
            messageKey: string
            versionId: string
            content: string
            finishReason?: string
          } | null
        } = { result: null }
        onMessageUpdate((prev) => {
          if (requestGenerationRef.current !== generation) return prev
          return updateLastAssistantMessage(prev, (message) => {
            const updatedMessage = applyChatCompletionResponse(
              message,
              response
            )

            if (!updatedMessage) return message

            // A non-streaming continuation may return only the new text; keep
            // the truncated prefix so the branch holds the complete answer.
            let completedMessage = updatedMessage
            if (prefix) {
              const version = getCurrentVersion(updatedMessage)
              if (!version.content.startsWith(prefix)) {
                completedMessage = updateCurrentVersionContent(
                  updatedMessage,
                  prefix + version.content
                )
              }
            }

            const completed = attachMessageVersionUsage(completedMessage, {
              requestId,
              usage,
            })
            const version = getCurrentVersion(completed)
            completion.result = {
              messageKey: completed.key,
              versionId: version.id,
              content: version.content,
              finishReason: version.finishReason,
            }
            return completed
          })
        }, requestSessionIdRef.current)
        continuationRef.current = null
        if (completion.result) onResponseComplete?.(completion.result)
      } catch (error: unknown) {
        if (
          abortController.signal.aborted ||
          requestGenerationRef.current !== generation
        ) {
          return
        }

        const { errorCode, errorMessage } = parseRequestErrorDetails(error)
        handleStreamError(generation, errorMessage, errorCode)
      } finally {
        if (requestGenerationRef.current === generation) {
          abortControllerRef.current = null
          setIsRequesting(false)
        }
      }
    },
    [
      config,
      parameterEnabled,
      systemPrompt,
      memoryBlock,
      contextSettings,
      stopStream,
      discardPendingStreamUpdates,
      onMessageUpdate,
      handleStreamError,
      onResponseComplete,
      sessionId,
    ]
  )

  // Send chat request (stream or non-stream based on config). Older messages
  // may reference attachments whose bytes or document text are not cached yet;
  // resolve them before the payload is built so the request still carries the
  // images and the extracted document context. The context summary (when
  // automatic summary is on) is resolved first, because the payload must carry
  // the node the plan then uses.
  const sendChat = useCallback(
    (messages: Message[], quote?: PlaygroundPendingQuote | null) => {
      continuationRef.current = null
      void Promise.all([
        ensurePlaygroundMessageAttachments(messages),
        ensurePlaygroundDocumentTexts(messages),
      ]).then(async () => {
        let prepared = messages
        if (prepareKnowledge) {
          try {
            prepared = await prepareKnowledge(messages)
          } catch {
            prepared = messages
          }
          if (prepared !== messages) {
            onMessageUpdate(() => prepared, sessionId)
          }
        }
        let contextSummary: PlaygroundContextSummary | null = null
        try {
          contextSummary = (await prepareContextSummary?.(prepared)) ?? null
        } catch {
          contextSummary = null
        }
        if (config.stream) {
          sendStreamingChat(prepared, contextSummary, quote)
        } else {
          void sendNonStreamingChat(prepared, contextSummary, undefined, quote)
        }
      })
    },
    [
      config.stream,
      onMessageUpdate,
      prepareContextSummary,
      prepareKnowledge,
      sendStreamingChat,
      sendNonStreamingChat,
      sessionId,
    ]
  )

  /**
   * Continue a truncated reply. The request carries the truncated reply as the
   * last assistant turn (assistant prefill semantics); a channel that rejects
   * that shape is retried once with `fallbackMessages`, which appends one user
   * continue instruction. The caller already appended the empty continuation
   * version, so the stream writes into it and the truncated version stays a
   * selectable branch.
   */
  const continueChat = useCallback(
    (
      prefillMessages: Message[],
      fallbackMessages: Message[],
      prefix: string
    ) => {
      continuationRef.current = {
        fallbackMessages,
        contextSummary: null,
        prefix,
      }
      void Promise.all([
        ensurePlaygroundMessageAttachments(prefillMessages),
        ensurePlaygroundDocumentTexts(prefillMessages),
      ]).then(async () => {
        let contextSummary: PlaygroundContextSummary | null = null
        try {
          contextSummary =
            (await prepareContextSummary?.(prefillMessages)) ?? null
        } catch {
          contextSummary = null
        }
        const pending = continuationRef.current
        if (!pending) return
        pending.contextSummary = contextSummary
        if (config.stream) {
          sendStreamingChat(prefillMessages, contextSummary)
        } else {
          void sendNonStreamingChat(prefillMessages, contextSummary, prefix)
        }
      })
    },
    [
      config.stream,
      prepareContextSummary,
      sendStreamingChat,
      sendNonStreamingChat,
    ]
  )

  // Stop generation
  const stopGeneration = useCallback(() => {
    const stoppedGeneration = requestGenerationRef.current
    flushStreamUpdates(stoppedGeneration)
    const idleGeneration = stoppedGeneration + 1
    requestGenerationRef.current = idleGeneration
    discardPendingStreamUpdates(idleGeneration)
    continuationRef.current = null
    stopStream()
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setIsRequesting(false)
    // A stopped stream was still billed for what it produced, so whatever
    // usage and request id arrived before the abort is kept. The reply keeps
    // the produced text and is labelled interrupted so "continue generation"
    // can pick it up.
    const generationRecord = {
      requestId: pendingRequestIdRef.current ?? undefined,
      usage: pendingUsageRef.current ?? undefined,
    }
    onMessageUpdate((prev) => {
      if (requestGenerationRef.current !== idleGeneration) return prev
      return updateLastAssistantMessage(prev, (message) =>
        isAssistantMessagePending(message)
          ? attachMessageVersionUsage(
              completeAssistantMessage(
                setCurrentVersionFinishReason(
                  message,
                  MESSAGE_FINISH_REASON.INTERRUPTED
                )
              ),
              generationRecord
            )
          : message
      )
    }, requestSessionIdRef.current)
  }, [
    stopStream,
    flushStreamUpdates,
    discardPendingStreamUpdates,
    onMessageUpdate,
  ])

  // The error handler reaches the transport through this ref so a failed
  // prefill can start the user-instruction retry without a dependency cycle.
  deliverPayloadRef.current = (messages, contextSummary, prefix) => {
    if (config.stream) {
      sendStreamingChat(messages, contextSummary)
      return
    }
    void sendNonStreamingChat(messages, contextSummary, prefix)
  }

  return {
    capturedRequest,
    sendChat,
    continueChat,
    stopGeneration,
    capturedRequest,
    isGenerating: isStreaming || isRequesting,
  }
}
