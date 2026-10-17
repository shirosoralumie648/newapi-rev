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
import { ERROR_MESSAGES } from '../constants'
import {
  applyStreamingChunk,
  applyToolCallDelta,
  attachMessageVersionUsage,
  buildChatCompletionPayload,
  ensurePlaygroundMessageAttachments,
  toMessageUsage,
  updateAssistantMessageWithError,
  updateLastAssistantMessage,
  parseRequestErrorDetails,
  applyChatCompletionResponse,
  completeAssistantMessage,
  hasChatCompletionChoice,
  isAssistantMessageFinal,
  isAssistantMessagePending,
} from '../lib'
import type { ToolCallDelta } from '../lib'
import type {
  Message,
  MessageUsage,
  PlaygroundConfig,
  ParameterEnabled,
} from '../types'
import { useStreamRequest } from './use-stream-request'

interface UseChatHandlerOptions {
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  /** Conversation-level instruction injected as the first request message. */
  systemPrompt: string
  onMessageUpdate: (
    updater: (prev: Message[]) => Message[],
    sessionId?: string | null
  ) => void
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
  onMessageUpdate,
  sessionId,
}: UseChatHandlerOptions) {
  const { t } = useTranslation()
  const { sendStreamRequest, stopStream, isStreaming } = useStreamRequest()
  const [isRequesting, setIsRequesting] = useState(false)
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

  // Handle stream complete
  const handleStreamComplete = useCallback(
    (generation: number) => {
      if (generation !== requestGenerationRef.current) return
      flushStreamUpdates(generation)
      setIsRequesting(false)
      const generationRecord = {
        requestId: pendingRequestIdRef.current ?? undefined,
        usage: pendingUsageRef.current ?? undefined,
      }
      onMessageUpdate((prev) => {
        if (generation !== requestGenerationRef.current) return prev
        return updateLastAssistantMessage(prev, (message) =>
          attachMessageVersionUsage(
            isAssistantMessageFinal(message)
              ? message
              : completeAssistantMessage(message),
            generationRecord
          )
        )
      }, requestSessionIdRef.current)
    },
    [flushStreamUpdates, onMessageUpdate]
  )

  // Handle stream error
  const handleStreamError = useCallback(
    (generation: number, error: string, errorCode?: string) => {
      if (generation !== requestGenerationRef.current) return
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
    [flushStreamUpdates, getDisplayError, onMessageUpdate, t]
  )

  // Send streaming chat request
  const sendStreamingChat = useCallback(
    (messages: Message[]) => {
      const generation = requestGenerationRef.current + 1
      requestGenerationRef.current = generation
      requestSessionIdRef.current = sessionId
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      pendingRequestIdRef.current = null
      pendingUsageRef.current = null
      discardPendingStreamUpdates(generation)
      setIsRequesting(true)
      const payload = buildChatCompletionPayload(
        messages,
        config,
        parameterEnabled,
        systemPrompt
      )
      void sendStreamRequest(payload, {
        onUpdate: (type, chunk) => handleStreamUpdate(generation, type, chunk),
        onToolCalls: (deltas) => handleToolCallDeltas(generation, deltas),
        onRequestId: (requestId) =>
          handleStreamRequestId(generation, requestId),
        onUsage: (usage) => handleStreamUsage(generation, usage),
        onComplete: () => handleStreamComplete(generation),
        onError: (error, errorCode) =>
          handleStreamError(generation, error, errorCode),
      })
    },
    [
      config,
      parameterEnabled,
      systemPrompt,
      sendStreamRequest,
      discardPendingStreamUpdates,
      handleStreamUpdate,
      handleToolCallDeltas,
      handleStreamRequestId,
      handleStreamUsage,
      handleStreamComplete,
      handleStreamError,
      sessionId,
    ]
  )

  // Send non-streaming chat request
  const sendNonStreamingChat = useCallback(
    async (messages: Message[]) => {
      const payload = buildChatCompletionPayload(
        messages,
        config,
        parameterEnabled,
        systemPrompt
      )
      const generation = requestGenerationRef.current + 1
      const abortController = new AbortController()

      requestGenerationRef.current = generation
      requestSessionIdRef.current = sessionId
      stopStream()
      pendingRequestIdRef.current = null
      pendingUsageRef.current = null
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
        onMessageUpdate((prev) => {
          if (requestGenerationRef.current !== generation) return prev
          return updateLastAssistantMessage(prev, (message) => {
            const updatedMessage = applyChatCompletionResponse(
              message,
              response
            )

            if (!updatedMessage) return message

            return attachMessageVersionUsage(updatedMessage, {
              requestId,
              usage,
            })
          })
        }, requestSessionIdRef.current)
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
      stopStream,
      discardPendingStreamUpdates,
      onMessageUpdate,
      handleStreamError,
      sessionId,
    ]
  )

  // Send chat request (stream or non-stream based on config). Older messages
  // may reference attachments whose bytes are not cached yet; load them before
  // the payload is built so the request still carries the images.
  const sendChat = useCallback(
    (messages: Message[]) => {
      void ensurePlaygroundMessageAttachments(messages).then(() => {
        if (config.stream) {
          sendStreamingChat(messages)
        } else {
          void sendNonStreamingChat(messages)
        }
      })
    },
    [config.stream, sendStreamingChat, sendNonStreamingChat]
  )

  // Stop generation
  const stopGeneration = useCallback(() => {
    const stoppedGeneration = requestGenerationRef.current
    flushStreamUpdates(stoppedGeneration)
    const idleGeneration = stoppedGeneration + 1
    requestGenerationRef.current = idleGeneration
    discardPendingStreamUpdates(idleGeneration)
    stopStream()
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setIsRequesting(false)
    // A stopped stream was still billed for what it produced, so whatever
    // usage and request id arrived before the abort is kept.
    const generationRecord = {
      requestId: pendingRequestIdRef.current ?? undefined,
      usage: pendingUsageRef.current ?? undefined,
    }
    onMessageUpdate((prev) => {
      if (requestGenerationRef.current !== idleGeneration) return prev
      return updateLastAssistantMessage(prev, (message) =>
        isAssistantMessagePending(message)
          ? attachMessageVersionUsage(
              completeAssistantMessage(message),
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

  return {
    sendChat,
    stopGeneration,
    isGenerating: isStreaming || isRequesting,
  }
}
