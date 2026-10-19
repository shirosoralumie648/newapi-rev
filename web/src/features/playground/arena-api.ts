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
import { z } from 'zod'

import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import { API_ENDPOINTS } from './constants'
import type {
  PlaygroundArenaChoice,
  PlaygroundArenaVote,
  PlaygroundArenaVoteSummary,
} from './types'

const arenaChoiceSchema = z.enum(['a', 'b', 'tie', 'both_bad'])

const arenaVoteSchema = z.object({
  id: z.number().int().positive(),
  message_key: z.string().min(1).max(200),
  choice: arenaChoiceSchema,
  note: z.string().max(500),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const arenaVoteListSchema = z.object({
  votes: z.array(arenaVoteSchema),
})

const arenaSummarySchema = z.object({
  scope: z.enum(['personal', 'instance']),
  total: z.number().int().nonnegative(),
  choices: z.object({
    a: z.number().int().nonnegative(),
    b: z.number().int().nonnegative(),
    tie: z.number().int().nonnegative(),
    both_bad: z.number().int().nonnegative(),
  }),
  notes: z.number().int().nonnegative(),
})

function mapVote(vote: z.output<typeof arenaVoteSchema>): PlaygroundArenaVote {
  return {
    id: vote.id,
    messageKey: vote.message_key,
    choice: vote.choice as PlaygroundArenaChoice,
    note: vote.note,
    createdAt: vote.created_at,
    updatedAt: vote.updated_at,
  }
}

function arenaSessionPath(sessionId: string): string {
  return `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/arena/votes`
}

/** The caller's own votes for one conversation, keyed back by message group. */
export async function listPlaygroundArenaVotes(
  sessionId: string,
  signal?: AbortSignal
): Promise<PlaygroundArenaVote[]> {
  const response = await api.get(arenaSessionPath(sessionId), { signal })
  requireServerSuccess(response.data)
  return arenaVoteListSchema.parse(response.data.data).votes.map(mapVote)
}

/**
 * Store or change one raw preference. The server keys the row by owner,
 * conversation and message group, so repeating or changing a vote updates the
 * same row instead of counting twice.
 */
export async function savePlaygroundArenaVote(
  sessionId: string,
  messageKey: string,
  choice: PlaygroundArenaChoice,
  note: string,
  signal?: AbortSignal
): Promise<PlaygroundArenaVote> {
  const response = await api.put(
    `${arenaSessionPath(sessionId)}/${encodeURIComponent(messageKey)}`,
    { choice, note },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapVote(arenaVoteSchema.parse(response.data.data))
}

/** Read-only personal or administrator-only instance choice totals. */
export async function getPlaygroundArenaVoteSummary(
  scope: 'personal' | 'instance',
  signal?: AbortSignal
): Promise<PlaygroundArenaVoteSummary> {
  const response = await api.get(`${API_ENDPOINTS.PLAYGROUND_ARENA}/summary`, {
    params: { scope },
    signal,
  })
  requireServerSuccess(response.data)
  const summary = arenaSummarySchema.parse(response.data.data)
  return {
    scope: summary.scope,
    total: summary.total,
    choices: {
      a: summary.choices.a,
      b: summary.choices.b,
      tie: summary.choices.tie,
      bothBad: summary.choices.both_bad,
    },
    notes: summary.notes,
  }
}
