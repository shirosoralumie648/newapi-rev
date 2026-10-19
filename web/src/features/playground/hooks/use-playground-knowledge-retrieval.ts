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
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { getServerMessage } from '@/lib/server-error-message'

import { MESSAGE_ROLES } from '../constants'
import { searchKnowledgeBase } from '../knowledge-api'
import { getCurrentVersion } from '../lib'
import {
  KNOWLEDGE_RETRIEVAL_TOP_K,
  mergeKnowledgeSearchResults,
} from '../lib/knowledge/retrieval'
import type { KnowledgeStaleDocument, Message } from '../types'

/**
 * Retrieval diagnostics of the last send: ready documents the merge skipped
 * because their chunks came from another model or vector size. The context
 * panel shows them and offers rebuilding in the knowledge manager.
 */
export interface PlaygroundKnowledgeDiagnostics {
  staleDocuments: KnowledgeStaleDocument[]
  resultCount: number
  retrievedAt: number
}

/**
 * Query the conversation's bound knowledge bases before a send. Retrieval runs
 * per base (each base owns its embedding model), then merges and numbers the
 * hits. A failure is reported and the turn continues without knowledge context,
 * exactly like an unavailable web search.
 */
export function usePlaygroundKnowledgeRetrieval() {
  const { t } = useTranslation()
  const [diagnostics, setDiagnostics] =
    useState<PlaygroundKnowledgeDiagnostics | null>(null)
  const [isRetrieving, setIsRetrieving] = useState(false)

  const retrieve = useCallback(
    async (
      messages: Message[],
      knowledgeBaseIds: string[],
      group: string,
      signal?: AbortSignal
    ): Promise<Message[]> => {
      if (knowledgeBaseIds.length === 0) {
        setDiagnostics(null)
        return messages
      }
      const lastUser = [...messages]
        .reverse()
        .find((message) => message.from === MESSAGE_ROLES.USER)
      if (!lastUser) return messages
      const query = getCurrentVersion(lastUser).content.trim()
      if (!query) return messages
      if (signal?.aborted) return messages
      if (lastUser.knowledge && lastUser.knowledge.query === query) {
        return messages
      }

      setIsRetrieving(true)
      try {
        const groups = await Promise.all(
          knowledgeBaseIds.map((knowledgeBaseId) =>
            searchKnowledgeBase(
              knowledgeBaseId,
              { query, topK: KNOWLEDGE_RETRIEVAL_TOP_K, group },
              signal
            )
          )
        )
        const merged = mergeKnowledgeSearchResults(groups)
        setDiagnostics({
          staleDocuments: merged.staleDocuments,
          resultCount: merged.hits.length,
          retrievedAt: Date.now(),
        })
        const updated = messages.map((message) =>
          message.key === lastUser.key
            ? { ...message, knowledge: { query, results: merged.hits } }
            : message
        )
        return updated
      } catch (error) {
        if (signal?.aborted) return messages
        const serverMessage = getServerMessage(error)
        toast.error(
          serverMessage
            ? t(serverMessage)
            : t(
                'Knowledge retrieval failed. Sending without knowledge context.'
              )
        )
        return messages
      } finally {
        setIsRetrieving(false)
      }
    },
    [t]
  )

  return { retrieve, diagnostics, isRetrieving }
}
