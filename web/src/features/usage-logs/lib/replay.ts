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
import type { UsageLog } from '../data/schema'
import type { LogOtherData } from '../types'

/**
 * Decides which usage logs can be reopened as a Playground draft. Only the
 * request-bearing consume and error logs of a chat-style endpoint qualify: the
 * Playground speaks the chat completions wire format, so image, embedding and
 * task paths have no draft to restore.
 */

const REPLAY_REQUEST_PATH_SUFFIXES = ['/chat/completions', '/messages']

function replayRequestPath(other: LogOtherData | null | undefined): string {
  const raw = other?.request_path
  if (typeof raw !== 'string') return ''
  const [path] = raw.split('?')
  return path.replace(/\/+$/, '')
}

export function isPlaygroundReplayableLog(
  log: Pick<UsageLog, 'type' | 'request_id'>,
  other: LogOtherData | null | undefined
): boolean {
  // 2 = consume, 5 = error; every other type is a payment or management event.
  if (log.type !== 2 && log.type !== 5) return false
  if (!log.request_id) return false
  const path = replayRequestPath(other)
  return REPLAY_REQUEST_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

export interface PlaygroundReplayLink {
  /** Log request id the replay endpoint resolves; the log table's stable key. */
  replay: string
  /**
   * Owner of the log. Only sent when an administrator views another account,
   * where the backend writes an audit row for the retained content.
   */
  replayUser?: number
}

export function buildPlaygroundReplayLink(
  log: Pick<UsageLog, 'type' | 'request_id' | 'user_id'>,
  other: LogOtherData | null | undefined,
  options?: { includeOwner?: boolean }
): PlaygroundReplayLink | null {
  if (!isPlaygroundReplayableLog(log, other)) return null
  return {
    replay: log.request_id,
    ...(options?.includeOwner ? { replayUser: log.user_id } : {}),
  }
}

export function buildPlaygroundReplayHref(link: PlaygroundReplayLink): string {
  const params = new URLSearchParams({ replay: link.replay })
  if (link.replayUser != null) {
    params.set('replayUser', String(link.replayUser))
  }
  return `/playground?${params.toString()}`
}
