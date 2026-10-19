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
import type { Message } from '../../types'
import { getActiveVersionIndex, getCurrentVersion } from './message-utils'

/**
 * Finish reasons that mark a reply as cut short: the provider stopped at the
 * token cap, or the user stopped the stream. Both keep the produced text as a
 * stored version, so the conversation can continue from it.
 */
export const MESSAGE_FINISH_REASON = {
  LENGTH: 'length',
  INTERRUPTED: 'interrupted',
} as const

/** Bound the stored label to the length the server accepts. */
export const MESSAGE_FINISH_REASON_MAX_LENGTH = 64

export function isTruncatedFinishReason(
  finishReason: string | undefined
): boolean {
  return (
    finishReason === MESSAGE_FINISH_REASON.LENGTH ||
    finishReason === MESSAGE_FINISH_REASON.INTERRUPTED
  )
}

/**
 * Whether the active version of a message was cut short. Such a reply offers
 * "continue generation"; the truncated version itself stays selectable as a
 * branch because continuing appends a new version.
 */
export function isMessageTruncated(message: Message): boolean {
  return isTruncatedFinishReason(getCurrentVersion(message).finishReason)
}

/**
 * Record why the active version's generation ended. An empty or over-long
 * value is ignored rather than stored; the label only drives the continue
 * action, so dropping it degrades to no action instead of a broken snapshot.
 */
export function setCurrentVersionFinishReason(
  message: Message,
  finishReason: string | undefined | null
): Message {
  const label = (finishReason ?? '')
    .trim()
    .slice(0, MESSAGE_FINISH_REASON_MAX_LENGTH)
  if (!label) return message
  if (getCurrentVersion(message).finishReason === label) return message

  const activeIndex = getActiveVersionIndex(message)
  if (!message.versions[activeIndex]) return message

  return {
    ...message,
    versions: message.versions.map((version, index) =>
      index === activeIndex ? { ...version, finishReason: label } : version
    ),
  }
}
