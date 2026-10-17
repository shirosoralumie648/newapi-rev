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
import { MESSAGE_ROLES, TOOL_CALL_STATUS } from '../../constants'
import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  Message,
  PlaygroundConfig,
  ParameterEnabled,
} from '../../types'
import {
  getMessageToolCalls,
  getToolCallResponseContent,
} from '../message/message-tool-call-utils'
import { formatMessageForAPI, isValidMessage } from '../message/message-utils'

// One stored message can become several request messages: an assistant reply
// that requested tool calls is followed by one `tool` message per answered
// call. Pending calls stay out until the user answers or denies them.
function formatMessageForRequest(message: Message): ChatCompletionMessage[] {
  const formatted = formatMessageForAPI(message)
  if (message.from !== MESSAGE_ROLES.ASSISTANT) {
    return [formatted]
  }

  const answeredCalls = getMessageToolCalls(message).filter(
    (call) => call.status !== TOOL_CALL_STATUS.PENDING
  )
  if (answeredCalls.length === 0) {
    return [formatted]
  }

  return [
    {
      ...formatted,
      tool_calls: answeredCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    },
    ...answeredCalls.map((call) => ({
      role: 'tool' as const,
      content: getToolCallResponseContent(call),
      tool_call_id: call.id,
    })),
  ]
}

/**
 * Build API request payload from messages and config. A conversation-level
 * system prompt is injected as the first `system` message; an empty or
 * whitespace-only prompt adds nothing.
 */
export function buildChatCompletionPayload(
  messages: Message[],
  config: PlaygroundConfig,
  parameterEnabled: ParameterEnabled,
  systemPrompt = ''
): ChatCompletionRequest {
  // Filter and format valid messages
  const processedMessages = messages
    .filter(isValidMessage)
    .flatMap(formatMessageForRequest)

  const prompt = systemPrompt.trim()
  const requestMessages: ChatCompletionMessage[] = prompt
    ? [{ role: 'system', content: prompt }, ...processedMessages]
    : processedMessages

  const payload: ChatCompletionRequest = {
    model: config.model,
    group: config.group,
    messages: requestMessages,
    stream: config.stream,
  }

  if (parameterEnabled.temperature) {
    payload.temperature = config.temperature
  }

  if (parameterEnabled.top_p) {
    payload.top_p = config.top_p
  }

  if (parameterEnabled.max_tokens) {
    payload.max_tokens = config.max_tokens
  }

  if (parameterEnabled.frequency_penalty) {
    payload.frequency_penalty = config.frequency_penalty
  }

  if (parameterEnabled.presence_penalty) {
    payload.presence_penalty = config.presence_penalty
  }

  if (parameterEnabled.seed && config.seed !== null) {
    payload.seed = config.seed
  }

  return payload
}
