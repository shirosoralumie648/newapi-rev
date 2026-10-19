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
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { sendChatCompletion } from '../api'
import { PLAYGROUND_CONTEXT_SUMMARY_MAX_BYTES } from '../constants'
import {
  buildContextSummaryRequest,
  hasChatCompletionChoice,
  normalizeContextSummary,
  planPlaygroundContext,
  toMessageUsage,
} from '../lib'
import type { PlaygroundContextPlan } from '../lib'
import type {
  Message,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../types'

interface UsePlaygroundContextOptions {
  sessionId: string | null
  messages: Message[]
  config: PlaygroundConfig
  systemPrompt: string
  /** Enabled cross-session memory block injected after the system prompt. */
  memoryBlock?: string
  settings: PlaygroundContextSettings
  summary: PlaygroundContextSummary | null
  /** Persists the compression node (or its removal) on the conversation. */
  onSummaryChange: (summary: PlaygroundContextSummary | null) => void
}

/**
 * Context management of the active conversation: the size plan of the next
 * send, the optional summarization the send waits for, and the manual
 * summarization behind the context panel. Summaries are ordinary
 * `/pg/chat/completions` calls, so they are billed through the same relay
 * pipeline as any other turn. A failed summarization degrades to the previous
 * node (or none) and lets the send continue with what the plan keeps.
 */
export function usePlaygroundContext(options: UsePlaygroundContextOptions) {
  const { t } = useTranslation()
  const [isSummarizing, setIsSummarizing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const latestRef = useRef(options)
  latestRef.current = options

  useEffect(
    () => () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    },
    []
  )

  const plan = useMemo(
    () =>
      planPlaygroundContext({
        messages: options.messages,
        settings: options.settings,
        summary: options.summary,
        systemPrompt: options.systemPrompt,
        memoryBlock: options.memoryBlock,
        model: options.config.model,
      }),
    [
      options.messages,
      options.settings,
      options.summary,
      options.systemPrompt,
      options.memoryBlock,
      options.config.model,
    ]
  )

  const runSummarization = useCallback(
    async (
      freshPlan: PlaygroundContextPlan
    ): Promise<PlaygroundContextSummary | null> => {
      const current = latestRef.current
      if (abortRef.current !== null || freshPlan.droppedMessages.length === 0) {
        return current.summary
      }
      const model = current.settings.summaryModel.trim() || current.config.model
      if (!model || !current.sessionId) return current.summary

      const controller = new AbortController()
      abortRef.current = controller
      setIsSummarizing(true)
      try {
        const payload = buildContextSummaryRequest({
          messages: freshPlan.droppedMessages,
          previousSummary: freshPlan.summaryUsed,
          model,
          group: current.config.group,
        })
        const { response, requestId } = await sendChatCompletion(
          payload,
          controller.signal
        )
        if (!hasChatCompletionChoice(response)) {
          throw new Error('Playground summarization returned no content')
        }
        const content = response.choices[0]?.message?.content?.trim() ?? ''
        if (!content) {
          throw new Error('Playground summarization returned no content')
        }
        // The server stores the summary with its byte contract; a longer
        // answer is a failed summarization, never a trimmed one.
        if (
          new TextEncoder().encode(content).byteLength >
          PLAYGROUND_CONTEXT_SUMMARY_MAX_BYTES
        ) {
          throw new Error('Playground summarization result is too large')
        }
        const previous = freshPlan.summaryUsed
        const lastDropped = freshPlan.droppedMessages.at(-1)
        if (!lastDropped) return current.summary
        const summary = normalizeContextSummary({
          id: nanoid(),
          content,
          throughMessageKey: lastDropped.key,
          messageCount:
            (previous?.messageCount ?? 0) + freshPlan.droppedMessages.length,
          model,
          createdAt: Date.now(),
          requestId,
          usage: toMessageUsage(response.usage),
        })
        if (!summary) {
          throw new Error('Playground summarization result is invalid')
        }
        current.onSummaryChange(summary)
        toast.success(t('Context summary saved'))
        return summary
      } catch {
        // A failed or canceled summary must not block the message: the send
        // continues with the previous node and whatever the limits keep.
        if (!controller.signal.aborted && mountedRef.current) {
          toast.error(
            t(
              'Unable to summarize the conversation. The full history will be sent instead.'
            )
          )
        }
        return latestRef.current.summary
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
        }
        if (mountedRef.current) {
          setIsSummarizing(false)
        }
      }
    },
    [t]
  )

  /**
   * The compression node the next send should use. With automatic summary on,
   * messages a limit leaves out are summarized first; every other case keeps
   * the current node so the send proceeds without waiting.
   */
  const prepareForSend = useCallback(
    async (messages: Message[]): Promise<PlaygroundContextSummary | null> => {
      const current = latestRef.current
      const freshPlan = planPlaygroundContext({
        messages,
        settings: current.settings,
        summary: current.summary,
        systemPrompt: current.systemPrompt,
        memoryBlock: current.memoryBlock,
        model: current.config.model,
      })
      if (!current.settings.autoSummarize || !freshPlan.needsSummary) {
        return current.summary
      }
      return runSummarization(freshPlan)
    },
    [runSummarization]
  )

  /**
   * Compress the messages the next send would leave out, without sending a
   * message. Does nothing when the plan already fits (nothing to summarize).
   */
  const summarizeNow = useCallback(async (): Promise<void> => {
    const current = latestRef.current
    const freshPlan = planPlaygroundContext({
      messages: current.messages,
      settings: current.settings,
      summary: current.summary,
      systemPrompt: current.systemPrompt,
      memoryBlock: current.memoryBlock,
      model: current.config.model,
    })
    if (!freshPlan.needsSummary) return
    await runSummarization(freshPlan)
  }, [runSummarization])

  return { plan, isSummarizing, prepareForSend, summarizeNow }
}
