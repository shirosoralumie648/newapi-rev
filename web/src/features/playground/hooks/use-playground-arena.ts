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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import {
  getPlaygroundArenaVoteSummary,
  listPlaygroundArenaVotes,
  savePlaygroundArenaVote,
} from '../arena-api'
import { playgroundQueryKeys } from '../lib/query-keys'
import type { PlaygroundArenaChoice } from '../types'

/**
 * Owner-scoped arena votes of one conversation plus the two read-only summary
 * scopes. Instance totals are only requested for administrators; the server
 * enforces the same rule. A saved vote invalidates both summaries so a changed
 * preference never leaves a stale total on screen.
 */
export function usePlaygroundArena(
  userId: number | null,
  sessionId: string | null,
  isAdmin: boolean,
  /**
   * Binds a still-local conversation before its first vote. The vote endpoint
   * resolves the conversation by its canonical server id, exactly like the
   * message and attachment routes.
   */
  ensureSessionId?: () => Promise<string | null>
) {
  const queryClient = useQueryClient()
  const votesQuery = useQuery({
    queryKey: playgroundQueryKeys.arenaVotes(userId, sessionId),
    enabled: userId !== null && Boolean(sessionId),
    queryFn: ({ signal }) => listPlaygroundArenaVotes(sessionId ?? '', signal),
    meta: { errorToast: false },
  })
  const personalSummary = useQuery({
    queryKey: playgroundQueryKeys.arenaSummary(userId, 'personal'),
    enabled: userId !== null,
    queryFn: ({ signal }) => getPlaygroundArenaVoteSummary('personal', signal),
    meta: { errorToast: false },
  })
  const instanceSummary = useQuery({
    queryKey: playgroundQueryKeys.arenaSummary(userId, 'instance'),
    enabled: userId !== null && isAdmin,
    queryFn: ({ signal }) => getPlaygroundArenaVoteSummary('instance', signal),
    meta: { errorToast: false },
  })

  const votesByMessageKey = useMemo(
    () =>
      new Map(
        (votesQuery.data ?? []).map((vote) => [vote.messageKey, vote] as const)
      ),
    [votesQuery.data]
  )

  const mutation = useMutation({
    mutationFn: (input: {
      sessionId: string
      messageKey: string
      choice: PlaygroundArenaChoice
      note: string
    }) =>
      savePlaygroundArenaVote(
        input.sessionId,
        input.messageKey,
        input.choice,
        input.note
      ),
    onSuccess: (_vote, input) => {
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.arenaVotes(userId, input.sessionId),
      })
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.arenaSummary(userId, 'personal'),
      })
      if (isAdmin) {
        void queryClient.invalidateQueries({
          queryKey: playgroundQueryKeys.arenaSummary(userId, 'instance'),
        })
      }
    },
  })

  const saveVote = useCallback(
    async (messageKey: string, choice: PlaygroundArenaChoice, note: string) => {
      const target =
        sessionId ?? (ensureSessionId ? await ensureSessionId() : null)
      if (!target) return
      await mutation.mutateAsync({
        sessionId: target,
        messageKey,
        choice,
        note,
      })
    },
    [ensureSessionId, mutation, sessionId]
  )

  return {
    votesByMessageKey,
    personalSummary: personalSummary.data,
    instanceSummary: instanceSummary.data,
    saveVote,
    isSaving: mutation.isPending,
  }
}
