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

import { sendChatCompletion } from '../api'
import { PLAYGROUND_PARALLEL_MIN_MODELS } from '../constants'
import {
  applyParallelCompletionChoice,
  applyParallelVersionError,
  buildChatCompletionPayload,
  ensurePlaygroundDocumentTexts,
  ensurePlaygroundMessageAttachments,
  getParallelPromptMessages,
  interruptParallelMessage,
  isParallelMessage,
  parseRequestErrorDetails,
  startParallelVersionRetry,
  toMessageUsage,
} from '../lib'
import { normalizeMessageRequestId } from '../lib/message/message-usage-utils'
import type {
  Message,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  ParameterEnabled,
} from '../types'

interface UseParallelChatOptions {
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  /** Conversation-level instruction injected as the first request message. */
  systemPrompt: string
  /** Context limits and summary model applied when the payloads are built. */
  contextSettings: PlaygroundContextSettings
  /** Messages of the active conversation; retries reuse the stored prefix. */
  messages: Message[]
  /**
   * Resolves the compression node the send should carry, exactly like the
   * ordinary chat path. A failed summarization never blocks the comparison.
   */
  prepareContextSummary?: (
    messages: Message[]
  ) => Promise<PlaygroundContextSummary | null>
  onMessageUpdate: (
    updater: (prev: Message[]) => Message[],
    sessionId?: string | null
  ) => void
  sessionId: string | null
}

/**
 * Drives one parallel comparison: the same conversation prefix goes to every
 * selected model as an independent `/pg/chat/completions` request, so each
 * reply is billed, grouped and rate limited by the ordinary relay pipeline.
 * The replies land as versions of one assistant message group; the user picks
 * the version that continues the conversation.
 */
export function useParallelChat(options: UseParallelChatOptions) {
  const [isComparing, setIsComparing] = useState(false)
  const generationRef = useRef(0)
  const comparingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const activeGroupKeyRef = useRef<string | null>(null)
  const sessionRef = useRef<string | null>(options.sessionId)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const applyVersionUpdate = useCallback(
    (
      generation: number,
      messageKey: string,
      update: (message: Message) => Message
    ) => {
      if (generation !== generationRef.current) return

      optionsRef.current.onMessageUpdate((prev) => {
        if (generation !== generationRef.current) return prev
        let changed = false
        const next = prev.map((message) => {
          if (message.key !== messageKey) return message
          const updated = update(message)
          changed = changed || updated !== message
          return updated
        })
        return changed ? next : prev
      }, sessionRef.current)
    },
    []
  )

  useEffect(
    () => () => {
      generationRef.current += 1
      comparingRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    },
    []
  )

  /**
   * Run the requests of one comparison (all versions, or one retried model).
   * `entries` maps a model to the version that stores its answer.
   */
  const runComparison = useCallback(
    async (
      promptMessages: Message[],
      groupMessageKey: string,
      entries: Array<{ model: string; versionIndex: number }>,
      contextSummary: PlaygroundContextSummary | null,
      prepare?: (message: Message) => Message
    ) => {
      const generation = generationRef.current + 1
      generationRef.current = generation
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      comparingRef.current = true
      setIsComparing(true)

      const current = () =>
        generation === generationRef.current && !controller.signal.aborted

      if (prepare) {
        applyVersionUpdate(generation, groupMessageKey, prepare)
      }

      await Promise.all(
        entries.map(async (entry) => {
          const latest = optionsRef.current
          const payload = buildChatCompletionPayload(
            promptMessages,
            { ...latest.config, model: entry.model, stream: false },
            latest.parameterEnabled,
            latest.systemPrompt,
            { settings: latest.contextSettings, summary: contextSummary }
          )

          let requestId: string | undefined
          try {
            const result = await sendChatCompletion(payload, controller.signal)
            requestId = normalizeMessageRequestId(result.requestId)
            if (!current()) return
            const choice = result.response.choices?.[0]
            if (!choice) {
              applyVersionUpdate(generation, groupMessageKey, (message) =>
                applyParallelVersionError(
                  message,
                  entry.versionIndex,
                  '',
                  undefined,
                  { requestId }
                )
              )
              return
            }
            const usage = toMessageUsage(result.response.usage)
            applyVersionUpdate(generation, groupMessageKey, (message) =>
              applyParallelCompletionChoice(
                message,
                entry.versionIndex,
                choice,
                {
                  requestId,
                  usage,
                }
              )
            )
          } catch (error: unknown) {
            if (!current()) return
            const { errorCode, errorMessage } = parseRequestErrorDetails(error)
            applyVersionUpdate(generation, groupMessageKey, (message) =>
              applyParallelVersionError(
                message,
                entry.versionIndex,
                errorMessage,
                errorCode,
                { requestId }
              )
            )
          }
        })
      )

      if (generation !== generationRef.current) return
      comparingRef.current = false
      setIsComparing(false)
      if (abortRef.current === controller) {
        abortRef.current = null
      }
      activeGroupKeyRef.current = null
    },
    [applyVersionUpdate]
  )

  /**
   * Send the conversation prefix to every model of the last message group. The
   * caller appended the user turn and the group first, so both the optimistic
   * UI and the persisted snapshot already hold them.
   */
  const sendParallelChat = useCallback(
    (messages: Message[]) => {
      const group = messages.at(-1)
      if (!isParallelMessage(group)) return
      const entries = group.versions
        .map((version, versionIndex) => ({
          model: (version.model ?? '').trim(),
          versionIndex,
        }))
        .filter((entry) => entry.model !== '')
      if (entries.length < PLAYGROUND_PARALLEL_MIN_MODELS) return

      const promptMessages = messages.slice(0, -1)
      activeGroupKeyRef.current = group.key
      sessionRef.current = optionsRef.current.sessionId

      void (async () => {
        await Promise.all([
          ensurePlaygroundMessageAttachments(promptMessages),
          ensurePlaygroundDocumentTexts(promptMessages),
        ])
        let contextSummary: PlaygroundContextSummary | null = null
        try {
          contextSummary =
            (await optionsRef.current.prepareContextSummary?.(messages)) ?? null
        } catch {
          contextSummary = null
        }
        await runComparison(promptMessages, group.key, entries, contextSummary)
      })()
    },
    [runComparison]
  )

  /**
   * Retry one failed model of a stored group. The other versions are untouched
   * and the request reuses the same conversation prefix, so the replies stay
   * comparable.
   */
  const retryParallelVersion = useCallback(
    (message: Message, versionIndex: number) => {
      if (comparingRef.current || !isParallelMessage(message)) return
      const model = message.versions[versionIndex]?.model
      if (!model) return

      sessionRef.current = optionsRef.current.sessionId
      const promptMessages = getParallelPromptMessages(
        optionsRef.current.messages,
        message.key
      )
      void (async () => {
        await Promise.all([
          ensurePlaygroundMessageAttachments(promptMessages),
          ensurePlaygroundDocumentTexts(promptMessages),
        ])
        let contextSummary: PlaygroundContextSummary | null = null
        try {
          contextSummary =
            (await optionsRef.current.prepareContextSummary?.(
              optionsRef.current.messages
            )) ?? null
        } catch {
          contextSummary = null
        }
        await runComparison(
          promptMessages,
          message.key,
          [{ model, versionIndex }],
          contextSummary,
          (current) => startParallelVersionRetry(current, versionIndex)
        )
      })()
    },
    [runComparison]
  )

  /**
   * Stop the running comparison. Replies that already arrived are kept; the
   * ones still in flight are settled as interrupted, so the group never keeps
   * a load that can no longer finish.
   */
  const stopComparison = useCallback(() => {
    const stoppedGeneration = generationRef.current
    const idleGeneration = stoppedGeneration + 1
    generationRef.current = idleGeneration
    comparingRef.current = false
    abortRef.current?.abort()
    abortRef.current = null
    setIsComparing(false)

    const groupKey = activeGroupKeyRef.current
    activeGroupKeyRef.current = null
    if (!groupKey) return
    applyVersionUpdate(idleGeneration, groupKey, (message) =>
      interruptParallelMessage(message)
    )
  }, [applyVersionUpdate])

  return {
    sendParallelChat,
    retryParallelVersion,
    stopComparison,
    isComparing,
  }
}
