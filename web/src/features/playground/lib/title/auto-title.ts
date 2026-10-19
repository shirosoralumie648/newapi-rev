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
  MESSAGE_ROLES,
  MESSAGE_STATUS,
  PLAYGROUND_AUTO_TITLE_INPUT_MAX_CHARS,
  PLAYGROUND_AUTO_TITLE_MAX_LENGTH,
  PLAYGROUND_AUTO_TITLE_MAX_TOKENS,
  PLAYGROUND_AUTO_TITLE_SYSTEM_PROMPT,
} from '../../constants'
import type { ChatCompletionRequest, Message } from '../../types'
import { getCurrentVersion } from '../message/message-utils'

/**
 * The completed reply a title may describe. Pending, failed and interrupted
 * versions are skipped so a stop or an error never becomes the conversation's
 * name; a version without an explicit status is a legacy completed reply.
 */
function completedAssistantContent(message: Message): string {
  if (message.from !== MESSAGE_ROLES.ASSISTANT) return ''
  if (
    message.status === MESSAGE_STATUS.LOADING ||
    message.status === MESSAGE_STATUS.STREAMING ||
    message.status === MESSAGE_STATUS.ERROR
  ) {
    return ''
  }
  const version = getCurrentVersion(message)
  if (
    version.status === MESSAGE_STATUS.LOADING ||
    version.status === MESSAGE_STATUS.STREAMING ||
    version.status === MESSAGE_STATUS.ERROR ||
    version.finishReason === 'interrupted'
  ) {
    return ''
  }
  return version.content.trim()
}

/**
 * Build the non-streaming completion that proposes a conversation title. Only
 * the first user message and the latest completed assistant reply are sent, so
 * the request stays small and the title describes what the conversation is
 * about instead of its whole history. The call is an ordinary billed `/pg`
 * request and returns null while either side is still missing.
 */
export function buildAutoTitleRequest(options: {
  messages: Message[]
  model: string
  group: string
}): ChatCompletionRequest | null {
  const model = options.model.trim()
  if (!model) return null
  const firstUser = options.messages.find(
    (message) =>
      message.from === MESSAGE_ROLES.USER &&
      getCurrentVersion(message).content.trim() !== ''
  )
  if (!firstUser) return null
  let lastAssistant: Message | undefined
  for (let index = options.messages.length - 1; index >= 0; index--) {
    if (options.messages[index].from === MESSAGE_ROLES.ASSISTANT) {
      lastAssistant = options.messages[index]
      break
    }
  }
  if (!lastAssistant) return null
  const assistantText = completedAssistantContent(lastAssistant)
  if (!assistantText) return null

  const transcript = [
    'User:',
    getCurrentVersion(firstUser).content.trim(),
    '',
    'Assistant:',
    assistantText,
  ].join('\n')
  const boundedInput =
    transcript.length > PLAYGROUND_AUTO_TITLE_INPUT_MAX_CHARS
      ? transcript.slice(0, PLAYGROUND_AUTO_TITLE_INPUT_MAX_CHARS)
      : transcript

  return {
    model,
    group: options.group,
    messages: [
      { role: 'system', content: PLAYGROUND_AUTO_TITLE_SYSTEM_PROMPT },
      { role: 'user', content: boundedInput },
    ],
    stream: false,
    temperature: 0.3,
    max_tokens: PLAYGROUND_AUTO_TITLE_MAX_TOKENS,
  }
}

/**
 * Normalize a model answer into a title: one line, no code fences, labels,
 * wrapping quotes or repeated whitespace, at most 50 characters. An empty
 * answer is a failed naming attempt and leaves the old title untouched.
 */
export function parseAutoTitleResponse(content: string): string | null {
  let title = content
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  title = title.split(/\r?\n/, 1)[0].trim()
  title = title
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(?:conversation\s+)?title\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) return null
  const bounded = Array.from(title)
    .slice(0, PLAYGROUND_AUTO_TITLE_MAX_LENGTH)
    .join('')
    .trim()
  return bounded || null
}
