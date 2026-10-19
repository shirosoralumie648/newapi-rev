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
import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  Message,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  ParameterEnabled,
} from '../../types'
import {
  formatMessageForRequest,
  planPlaygroundContext,
} from '../context/playground-context'
import { applyModelMediaPolicy } from '../message/message-media-utils'
import { isValidMessage } from '../message/message-utils'
import {
  modelSupportsReasoningEffort,
  normalizeReasoningEffort,
} from '../parameters/playground-reasoning'

/**
 * Context management input for one payload: the conversation's settings and
 * the compression node that applies. Omitted entirely when the caller wants
 * the plain stored history (legacy call sites and tests).
 */
export interface ChatCompletionPayloadContext {
  settings: PlaygroundContextSettings
  summary?: PlaygroundContextSummary | null
}

/**
 * Build API request payload from messages and config. A conversation-level
 * system prompt is injected as the first `system` message and the owner's
 * cross-session memory block right after it; an empty or whitespace-only value
 * adds nothing. With context management enabled the request carries only the
 * messages the plan keeps, prefixed by the compression node when one applies.
 */
export function buildChatCompletionPayload(
  messages: Message[],
  config: PlaygroundConfig,
  parameterEnabled: ParameterEnabled,
  systemPrompt = '',
  context?: ChatCompletionPayloadContext,
  memoryBlock = ''
): ChatCompletionRequest {
  // Filter and format valid messages; the plan applies the limits and the
  // compression node, the plain path sends the history unchanged.
  const plan = context
    ? planPlaygroundContext({
        messages,
        settings: context.settings,
        summary: context.summary,
        systemPrompt,
        memoryBlock,
        model: config.model,
      })
    : null
  const processedMessages: ChatCompletionMessage[] = plan
    ? plan.requestMessages
    : messages.filter(isValidMessage).flatMap(formatMessageForRequest)

  const prompt = systemPrompt.trim()
  const memory = memoryBlock.trim()
  const baseMessages: ChatCompletionMessage[] = [
    ...(prompt ? [{ role: 'system' as const, content: prompt }] : []),
    ...(memory ? [{ role: 'system' as const, content: memory }] : []),
    ...processedMessages,
  ]
  // Stored messages stay untouched: the policy only changes this request, so a
  // base64 payload produced by an image model or an image a text-only model
  // cannot accept is replaced without deleting anything from the conversation.
  const requestMessages = applyModelMediaPolicy(
    baseMessages,
    config.model
  ).messages

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

  if (
    parameterEnabled.reasoning_effort &&
    modelSupportsReasoningEffort(config.model)
  ) {
    // Only a value the relay accepts is forwarded; a stale or edited stored
    // value silently leaves the parameter unset instead of failing the request.
    const effort = normalizeReasoningEffort(config.reasoning_effort)
    if (effort) {
      payload.reasoning_effort = effort
    }
  }

  return payload
}
