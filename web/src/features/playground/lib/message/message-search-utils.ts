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
import type { MessageRole, PlaygroundSession } from '../../types'
import { getMessageContentState } from './message-content-utils'
import { getMessageContent } from './message-utils'

/** Most hits one search returns, so a short query cannot freeze the dialog. */
export const PLAYGROUND_MESSAGE_SEARCH_LIMIT = 50
/** Characters of context kept on each side of the match. */
export const PLAYGROUND_MESSAGE_SEARCH_SNIPPET_PADDING = 40

/**
 * One message of the hydrated workspace matching the query. The three text
 * parts split the surrounding snippet around the match so the caller can
 * render the match as highlighted text.
 */
export interface PlaygroundMessageSearchHit {
  sessionId: string
  sessionTitle: string
  messageKey: string
  from: MessageRole
  before: string
  match: string
  after: string
}

/**
 * Search every hydrated conversation for the query, newest conversation first.
 * Only the visible text of each message's active version is searched, so a hit
 * always points at text the reader can see; a workspace that is still
 * hydrating is searched as far as it is loaded and the caller labels that.
 */
export function searchPlaygroundMessages(
  sessions: PlaygroundSession[],
  query: string,
  limit: number = PLAYGROUND_MESSAGE_SEARCH_LIMIT
): PlaygroundMessageSearchHit[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []

  const hits: PlaygroundMessageSearchHit[] = []
  const orderedSessions = [...sessions].sort(
    (first, second) => second.updatedAt - first.updatedAt
  )
  for (const session of orderedSessions) {
    for (const message of session.messages) {
      if (hits.length >= limit) return hits
      const text = getMessageContentState(
        message,
        getMessageContent(message)
      ).displayContent
      const index = text.toLocaleLowerCase().indexOf(needle)
      if (index === -1) continue
      hits.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageKey: message.key,
        from: message.from,
        before: text.slice(
          Math.max(0, index - PLAYGROUND_MESSAGE_SEARCH_SNIPPET_PADDING),
          index
        ),
        match: text.slice(index, index + needle.length),
        after: text.slice(
          index + needle.length,
          index + needle.length + PLAYGROUND_MESSAGE_SEARCH_SNIPPET_PADDING
        ),
      })
    }
  }
  return hits
}
