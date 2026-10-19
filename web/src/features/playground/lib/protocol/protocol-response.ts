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
import { PLAYGROUND_PROTOCOL_UNSUPPORTED_HINT } from '../../constants'
import type {
  ChatCompletionResponse,
  ChatCompletionToolCall,
  PlaygroundProtocol,
} from '../../types'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  return value as JsonObject
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toolCallFromResponses(item: JsonObject): ChatCompletionToolCall {
  const callId = asString(item.call_id) || asString(item.id)
  return {
    id: callId,
    type: 'function',
    function: {
      name: asString(item.name),
      arguments: asString(item.arguments) || '{}',
    },
  }
}

function responsesContentAndCalls(output: unknown[]): {
  content: string
  reasoning: string
  toolCalls: ChatCompletionToolCall[]
} {
  const contentParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls: ChatCompletionToolCall[] = []
  for (const rawItem of output) {
    const item = asObject(rawItem)
    if (!item) continue
    if (item.type === 'function_call') {
      toolCalls.push(toolCallFromResponses(item))
      continue
    }
    if (item.type === 'reasoning') {
      for (const summary of asArray(item.summary)) {
        const text = asString(asObject(summary)?.text)
        if (text !== '') reasoningParts.push(text)
      }
      continue
    }
    if (item.type !== 'message') continue
    for (const rawPart of asArray(item.content)) {
      const part = asObject(rawPart)
      if (part?.type === 'output_text') contentParts.push(asString(part.text))
    }
  }
  return {
    content: contentParts.join(''),
    reasoning: reasoningParts.join(''),
    toolCalls,
  }
}

function messagesContentAndCalls(content: unknown[]): {
  content: string
  reasoning: string
  toolCalls: ChatCompletionToolCall[]
} {
  const contentParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls: ChatCompletionToolCall[] = []
  for (const rawBlock of content) {
    const block = asObject(rawBlock)
    if (!block) continue
    if (block.type === 'text') {
      contentParts.push(asString(block.text))
      continue
    }
    if (block.type === 'thinking') {
      reasoningParts.push(asString(block.thinking))
      continue
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: asString(block.id),
        type: 'function',
        function: {
          name: asString(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }
  return {
    content: contentParts.join(''),
    reasoning: reasoningParts.join(''),
    toolCalls,
  }
}

function usageFromTokens(
  prompt: number,
  completion: number,
  total?: number
): ChatCompletionResponse['usage'] {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total ?? prompt + completion,
  }
}

function responsesToChatCompletion(data: JsonObject): ChatCompletionResponse {
  const { content, reasoning, toolCalls } = responsesContentAndCalls(
    asArray(data.output)
  )
  const usage = asObject(data.usage)
  const inputTokens = asNumber(usage?.input_tokens) ?? 0
  const outputTokens = asNumber(usage?.output_tokens) ?? 0
  const totalTokens = asNumber(usage?.total_tokens)
  const incomplete = asObject(data.incomplete_details)
  let finishReason = 'stop'
  if (incomplete?.reason === 'max_output_tokens') {
    finishReason = 'length'
  } else if (toolCalls.length > 0) {
    finishReason = 'tool_calls'
  }

  return {
    id: asString(data.id),
    object: 'chat.completion',
    created: asNumber(data.created_at) ?? 0,
    model: asString(data.model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: usageFromTokens(inputTokens, outputTokens, totalTokens),
  }
}

function messagesStopReason(
  stopReason: unknown,
  hasToolCalls: boolean
): string {
  if (stopReason === 'max_tokens') return 'length'
  if (stopReason === 'tool_use' || hasToolCalls) return 'tool_calls'
  return 'stop'
}

function messagesToChatCompletion(data: JsonObject): ChatCompletionResponse {
  const { content, reasoning, toolCalls } = messagesContentAndCalls(
    asArray(data.content)
  )
  const usage = asObject(data.usage)
  const inputTokens = asNumber(usage?.input_tokens) ?? 0
  const outputTokens = asNumber(usage?.output_tokens) ?? 0

  return {
    id: asString(data.id),
    object: 'chat.completion',
    created: 0,
    model: asString(data.model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: messagesStopReason(
          data.stop_reason,
          toolCalls.length > 0
        ),
      },
    ],
    usage: usageFromTokens(inputTokens, outputTokens),
  }
}

/**
 * Normalizes a complete Responses or Messages reply into the internal chat
 * completion shape, so the existing message lifecycle (versions, usage,
 * tool calls, finish reason) handles every protocol identically.
 */
export function parsePlaygroundProtocolCompletion(
  protocol: PlaygroundProtocol,
  data: unknown
): ChatCompletionResponse {
  const parsed = asObject(data)
  if (!parsed) {
    throw new Error('The completion response was not a JSON object.')
  }
  if (protocol === 'responses') return responsesToChatCompletion(parsed)
  if (protocol === 'messages') return messagesToChatCompletion(parsed)
  return data as ChatCompletionResponse
}

const UNSUPPORTED_ERROR_CODES = new Set([
  'convert_request_failed',
  'unsupported_protocol',
  'channel_not_support',
])

const UNSUPPORTED_MESSAGE_PATTERN =
  /not\s+support|unsupport|does(?:n't| not) support|不支持/i

/**
 * Returns the hint shown beside a relay error when the selected protocol is the
 * limiting factor (a channel or model that cannot speak it). The hint suggests
 * the concrete next action instead of leaving the raw conversion error alone.
 */
export function playgroundProtocolUnsupportedHint(
  protocol: PlaygroundProtocol,
  errorCode?: string,
  errorMessage?: string
): string | null {
  if (protocol === 'chat') return null
  if (errorCode && UNSUPPORTED_ERROR_CODES.has(errorCode)) {
    return PLAYGROUND_PROTOCOL_UNSUPPORTED_HINT
  }
  if (errorMessage && UNSUPPORTED_MESSAGE_PATTERN.test(errorMessage)) {
    return PLAYGROUND_PROTOCOL_UNSUPPORTED_HINT
  }
  return null
}
