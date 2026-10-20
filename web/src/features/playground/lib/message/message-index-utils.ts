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
import type { Message, MessageRole } from '../../types'
import { getMessageContentState } from './message-content-utils'
import { getMessageContent } from './message-utils'

/** Fixed row height of the jump list, in pixels. */
export const MESSAGE_JUMP_ROW_HEIGHT = 64
/** Rows rendered beyond the visible window, on each side. */
export const MESSAGE_JUMP_OVERSCAN = 3
/** Visible text one index entry keeps for search and its preview. */
export const MESSAGE_JUMP_PREVIEW_CHARS = 160

export interface PlaygroundMessageIndexEntry {
  key: string
  /** Position of the message in the conversation, newest last. */
  index: number
  from: MessageRole
  /** Full visible text searched by the jump dialog. */
  text: string
  /** Whitespace-collapsed excerpt rendered in the list. */
  preview: string
}

/**
 * Builds the local index of one conversation. Only the visible text of each
 * message's active version is indexed, so a jump always lands on text the
 * reader can see and no hidden branch is searched.
 */
export function buildPlaygroundMessageIndex(
  messages: readonly Message[]
): PlaygroundMessageIndexEntry[] {
  return messages.map((message, index) => {
    const text = getMessageContentState(
      message,
      getMessageContent(message)
    ).displayContent
    return {
      key: message.key,
      index,
      from: message.from,
      text,
      preview: text
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MESSAGE_JUMP_PREVIEW_CHARS),
    }
  })
}

/** Case-insensitive filter over the visible text and the role. */
export function filterPlaygroundMessageIndex(
  entries: readonly PlaygroundMessageIndexEntry[],
  query: string
): PlaygroundMessageIndexEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...entries]
  return entries.filter(
    (entry) =>
      entry.text.toLocaleLowerCase().includes(needle) ||
      entry.from.includes(needle)
  )
}

export interface PlaygroundMessageJumpWindow {
  /** First row index of the rendered window. */
  start: number
  /** One past the last rendered row index. */
  end: number
  /** Absolute top of the first rendered row. */
  offset: number
  /** Scroll height of the whole list. */
  totalHeight: number
}

/**
 * Fixed-row windowing for the jump list: only the rows around the viewport are
 * mounted, while the spacer keeps the scrollbar proportional to the whole
 * conversation. The window is clamped to the end so a short list never renders
 * rows that do not exist.
 */
export function messageJumpWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = MESSAGE_JUMP_ROW_HEIGHT,
  overscan: number = MESSAGE_JUMP_OVERSCAN
): PlaygroundMessageJumpWindow {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0) {
    return { start: 0, end: 0, offset: 0, totalHeight: 0 }
  }
  const visible = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  const maxStart = Math.max(0, safeTotal - visible)
  const start = Math.min(
    Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan),
    maxStart
  )
  const end = Math.min(safeTotal, start + visible + overscan * 2)
  return {
    start,
    end,
    offset: start * rowHeight,
    totalHeight: safeTotal * rowHeight,
  }
}

/** Scroll offset that brings one row into view. */
export function messageJumpScrollTop(
  index: number,
  rowHeight: number = MESSAGE_JUMP_ROW_HEIGHT
): number {
  return Math.max(0, index) * rowHeight
}
