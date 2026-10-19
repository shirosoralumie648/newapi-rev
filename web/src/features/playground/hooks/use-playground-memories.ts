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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  createPlaygroundMemory,
  getPlaygroundMemories,
  sendChatCompletion,
  updatePlaygroundMemory,
} from '../api'
import { MESSAGE_ROLES } from '../constants'
import {
  buildMemoryExtractionRequest,
  diffMemoryCandidates,
  parseMemoryExtractionResponse,
} from '../lib/memory/playground-memory'
import { getCurrentVersion } from '../lib/message/message-utils'
import { playgroundQueryKeys } from '../lib/query-keys'
import type {
  Message,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundMemoryExtractionSettings,
} from '../types'

/** The owner's durable memories, shared by the panel and the send payload. */
export function usePlaygroundMemories(userId: number | null, enabled = true) {
  return useQuery({
    queryKey: playgroundQueryKeys.memories(userId),
    queryFn: ({ signal }) => getPlaygroundMemories(signal),
    enabled: userId !== null && enabled,
    meta: { errorToast: false, keepPageOnInternalServerError: true },
  })
}

interface UsePlaygroundMemoryExtractionOptions {
  userId: number | null
  config: PlaygroundConfig
  contextSettings: PlaygroundContextSettings
  settings: PlaygroundMemoryExtractionSettings
  messages: Message[]
  /** Server session the completed reply belongs to; sent as the memory source. */
  sourceSessionId: string | null
  /** True while a reply streams or a comparison runs; extraction starts when it ends. */
  isBusy: boolean
}

/**
 * Extracts durable notes after a reply finishes. The extraction is one ordinary
 * billed non-streaming `/pg/chat/completions` call, runs at most once per
 * completed reply, and only reads the owner's own user messages. A failed or
 * empty extraction is silent: the completed reply is never disturbed.
 */
export function usePlaygroundMemoryExtraction(
  options: UsePlaygroundMemoryExtractionOptions
) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [isExtracting, setIsExtracting] = useState(false)
  const runningRef = useRef(false)
  const wasBusyRef = useRef(options.isBusy)
  const extractedRef = useRef<string | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const extract = useCallback(
    async (messages: Message[]) => {
      const current = optionsRef.current
      if (
        current.userId === null ||
        !current.settings.enabled ||
        runningRef.current
      ) {
        return
      }
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.from === MESSAGE_ROLES.ASSISTANT)
      if (!lastAssistant) return
      const version = getCurrentVersion(lastAssistant)
      if (!version.content.trim()) return
      const hasUserContent = messages.some(
        (message) =>
          message.from === MESSAGE_ROLES.USER &&
          getCurrentVersion(message).content.trim() !== ''
      )
      if (!hasUserContent) return
      const identity = `${lastAssistant.key}:${version.id}`
      if (extractedRef.current === identity) return
      const model =
        current.settings.model.trim() ||
        current.contextSettings.summaryModel.trim() ||
        current.config.model
      if (!model) return

      runningRef.current = true
      setIsExtracting(true)
      try {
        const listing = await queryClient.ensureQueryData({
          queryKey: playgroundQueryKeys.memories(current.userId),
          queryFn: ({ signal }) => getPlaygroundMemories(signal),
        })
        if (extractedRef.current === identity) return
        const request = buildMemoryExtractionRequest({
          messages,
          memories: listing.items,
          model,
          group: current.config.group,
        })
        const { response } = await sendChatCompletion(request)
        const candidates = parseMemoryExtractionResponse(
          response.choices?.[0]?.message?.content ?? ''
        )
        const plan = diffMemoryCandidates(
          listing.items,
          candidates,
          Math.max(0, listing.limit - listing.total)
        )
        for (const update of plan.updates) {
          await updatePlaygroundMemory(update.id, {
            content: update.content,
            category: update.category,
          })
        }
        for (const create of plan.creates) {
          await createPlaygroundMemory({
            content: create.content,
            category: create.category,
            ...(current.sourceSessionId
              ? { source_session_id: current.sourceSessionId }
              : {}),
          })
        }
        extractedRef.current = identity
        if (plan.creates.length > 0 || plan.updates.length > 0) {
          await queryClient.invalidateQueries({
            queryKey: playgroundQueryKeys.memories(current.userId),
          })
          await queryClient.invalidateQueries({
            queryKey: playgroundQueryKeys.usage(current.userId),
          })
          toast.success(t('Memory updated'))
        }
      } catch {
        // Automatic extraction is best-effort; the reply already completed and
        // a failed proposal must not surface an error over the conversation.
      } finally {
        runningRef.current = false
        setIsExtracting(false)
      }
    },
    [queryClient, t]
  )

  useEffect(() => {
    const wasBusy = wasBusyRef.current
    wasBusyRef.current = options.isBusy
    if (!wasBusy || options.isBusy) return
    void extract(optionsRef.current.messages)
  }, [options.isBusy, extract])

  return { extract, isExtracting }
}
