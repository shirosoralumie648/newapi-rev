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
import { useQuery } from '@tanstack/react-query'

import { requireServerSuccess } from '@/lib/server-error-message'

import { getUserGroups } from '../api'
import { listKnowledgeBases, listKnowledgeDocuments } from '../knowledge-api'
import { playgroundQueryKeys } from '../lib/query-keys'
import type { GroupOption } from '../types'

export function useKnowledgeBases(userId: number | null) {
  return useQuery({
    queryKey: playgroundQueryKeys.knowledgeBases(userId),
    queryFn: ({ signal }) => listKnowledgeBases(signal),
    enabled: userId !== null,
    meta: { errorToast: false },
  })
}

export function useKnowledgeDocuments(
  userId: number | null,
  knowledgeBaseId: string | null
) {
  return useQuery({
    queryKey: playgroundQueryKeys.knowledgeDocuments(
      userId,
      knowledgeBaseId ?? ''
    ),
    queryFn: ({ signal }) =>
      listKnowledgeDocuments(knowledgeBaseId ?? '', signal),
    enabled: userId !== null && knowledgeBaseId !== null,
    meta: { errorToast: false },
  })
}

/**
 * Groups the account may run the embedding relay in. The query key is shared
 * with the workspace and canvas workflow option queries, so opening the
 * knowledge manager reuses the option list already on screen.
 */
export function useKnowledgeGroups(userId: number | null) {
  return useQuery<GroupOption[]>({
    queryKey: ['playground-groups', userId],
    queryFn: async () => requireServerSuccess(await getUserGroups()),
    enabled: userId !== null,
    meta: { errorToast: false },
  })
}
