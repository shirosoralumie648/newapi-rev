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
import {
  PLAYGROUND_QUOTE_CONTEXT_CLOSE,
  PLAYGROUND_QUOTE_CONTEXT_OPEN,
  PLAYGROUND_QUOTE_TEXT_MAX_CHARS,
} from '../../constants'
import type {
  ChatCompletionMessage,
  Message,
  PlaygroundPendingQuote,
} from '../../types'
import { getMessageContentState } from './message-content-utils'
import { getMessageContent } from './message-utils'

/**
 * Snapshot of one message for the composer quote. Only the visible text of the
 * active version is quoted (a quoted reply keeps the same text the reader
 * sees) and the snapshot is bounded by the quote cap; a message without
 * visible text cannot be quoted.
 */
export function createPendingQuote(
  message: Message
): PlaygroundPendingQuote | null {
  const text = getMessageContentState(
    message,
    getMessageContent(message)
  ).displayContent.trim()
  if (!text) return null
  return {
    messageKey: message.key,
    text: text.slice(0, PLAYGROUND_QUOTE_TEXT_MAX_CHARS),
  }
}

/**
 * The `user` message a pending quote prepends to the next request. It is model
 * protocol content, so it stays untranslated, and it is never stored: the next
 * payload builder call is the only consumer.
 */
export function buildQuoteRequestMessage(
  quote: PlaygroundPendingQuote
): ChatCompletionMessage | null {
  const text = quote.text.trim().slice(0, PLAYGROUND_QUOTE_TEXT_MAX_CHARS)
  if (!text) return null
  const open = PLAYGROUND_QUOTE_CONTEXT_OPEN.replace(
    '{{key}}',
    quote.messageKey
  )
  return {
    role: 'user',
    content: `${open}\n${text}\n${PLAYGROUND_QUOTE_CONTEXT_CLOSE}`,
  }
}
