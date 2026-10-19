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
  ChatCompletionToolCallDelta,
  MessageUsage,
  PlaygroundProtocol,
} from '../../types'
import type { StreamChunkParseResult } from '../streaming/stream-utils'

/** A failure frame of the protocol stream, in the shape the UI already shows. */
export interface PlaygroundProtocolStreamError {
  errorCode?: string
  errorMessage: string
}

/**
 * One parsed protocol stream frame. `done` marks the terminal frame, `error`
 * replaces the ordinary update fields when the upstream reported a failure.
 */
export interface PlaygroundProtocolStreamOutcome extends StreamChunkParseResult {
  done?: boolean
  error?: PlaygroundProtocolStreamError
}

export type PlaygroundProtocolStreamParser = (
  eventName: string,
  data: string
) => PlaygroundProtocolStreamOutcome | null

interface ResponsesStreamState {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Wire output index → dense tool-call index used by the message model. */
  toolCallIndexes: Map<number, number>
}

interface MessagesStreamState {
  inputTokens: number
  outputTokens: number
  /** Wire content-block index → dense tool-call index. */
  toolCallIndexes: Map<number, number>
}

/**
 * Maps a protocol-specific output/block index onto the dense index the message
 * UI stores. Both protocols number every output block (text, reasoning, tool
 * use), while the chat tool-call array only counts calls, so passing the wire
 * index through would create gaps that the UI rejects.
 */
function resolveToolCallIndex(
  indexes: Map<number, number>,
  wireIndex: number
): number {
  const existing = indexes.get(wireIndex)
  if (existing !== undefined) return existing
  const index = indexes.size
  indexes.set(wireIndex, index)
  return index
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageResult(
  promptTokens: number,
  completionTokens: number,
  totalTokens?: number
): MessageUsage | undefined {
  if (promptTokens <= 0 && completionTokens <= 0 && (totalTokens ?? 0) <= 0) {
    return undefined
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens ?? promptTokens + completionTokens,
  }
}

/**
 * Anthropic stop reasons mapped onto the generic finish reasons the message
 * lifecycle uses (`length` enables continue generation).
 */
function messagesFinishReason(stopReason: unknown): string | undefined {
  if (typeof stopReason !== 'string') return undefined
  switch (stopReason) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
      return 'stop'
    default:
      return stopReason
  }
}

function responsesFinishReason(
  incompleteReason: unknown,
  hasToolCalls: boolean
): string {
  if (incompleteReason === 'max_output_tokens') return 'length'
  return hasToolCalls ? 'tool_calls' : 'stop'
}

function parseResponsesEvent(
  type: string,
  parsed: Record<string, unknown>,
  state: ResponsesStreamState
): PlaygroundProtocolStreamOutcome | null {
  switch (type) {
    case 'response.output_text.delta': {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
      if (delta === '') return null
      return { updates: [{ type: 'content', chunk: delta }], toolCalls: [] }
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
      if (delta === '') return null
      return { updates: [{ type: 'reasoning', chunk: delta }], toolCalls: [] }
    }
    case 'response.output_item.added': {
      const item = parsed.item as Record<string, unknown> | undefined
      if (!item || item.type !== 'function_call') return null
      const wireIndex = numericField(parsed.output_index) ?? 0
      const index = resolveToolCallIndex(state.toolCallIndexes, wireIndex)
      const delta: ChatCompletionToolCallDelta = {
        index,
        function: {
          name: typeof item.name === 'string' ? item.name : undefined,
          arguments: '',
        },
      }
      const callId = item.call_id ?? item.id
      if (typeof callId === 'string') delta.id = callId
      return { updates: [], toolCalls: [delta] }
    }
    case 'response.function_call_arguments.delta': {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
      if (delta === '') return null
      const wireIndex = numericField(parsed.output_index) ?? 0
      return {
        updates: [],
        toolCalls: [
          {
            index: resolveToolCallIndex(state.toolCallIndexes, wireIndex),
            function: { arguments: delta },
          },
        ],
      }
    }
    case 'response.completed':
    case 'response.incomplete': {
      const response = parsed.response as Record<string, unknown> | undefined
      const usage = response?.usage as Record<string, unknown> | undefined
      state.inputTokens = numericField(usage?.input_tokens) ?? state.inputTokens
      state.outputTokens =
        numericField(usage?.output_tokens) ?? state.outputTokens
      state.totalTokens = numericField(usage?.total_tokens) ?? state.totalTokens
      const output = Array.isArray(response?.output) ? response.output : []
      const hasToolCalls = output.some(
        (item) =>
          (item as Record<string, unknown> | null)?.type === 'function_call'
      )
      const incomplete = response?.incomplete_details as
        | Record<string, unknown>
        | undefined
      const usageFrame = usageResult(
        state.inputTokens,
        state.outputTokens,
        state.totalTokens || undefined
      )
      return {
        updates: [],
        toolCalls: [],
        done: true,
        ...(usageFrame ? { usage: usageFrame } : {}),
        finishReason: responsesFinishReason(incomplete?.reason, hasToolCalls),
      }
    }
    case 'response.failed': {
      const response = parsed.response as Record<string, unknown> | undefined
      const failure = response?.error as Record<string, unknown> | undefined
      const message =
        typeof failure?.message === 'string'
          ? failure.message
          : 'The upstream response failed.'
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      return {
        updates: [],
        toolCalls: [],
        error: { errorCode: code, errorMessage: message },
      }
    }
    case 'error': {
      const failure = parsed.error as Record<string, unknown> | undefined
      const message =
        typeof failure?.message === 'string'
          ? failure.message
          : 'The upstream stream reported an error.'
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      return {
        updates: [],
        toolCalls: [],
        error: { errorCode: code, errorMessage: message },
      }
    }
    default:
      return null
  }
}

function parseMessagesEvent(
  type: string,
  parsed: Record<string, unknown>,
  state: MessagesStreamState
): PlaygroundProtocolStreamOutcome | null {
  switch (type) {
    case 'message_start': {
      const message = parsed.message as Record<string, unknown> | undefined
      const usage = message?.usage as Record<string, unknown> | undefined
      const cached =
        (numericField(usage?.cache_creation_input_tokens) ?? 0) +
        (numericField(usage?.cache_read_input_tokens) ?? 0)
      state.inputTokens = (numericField(usage?.input_tokens) ?? 0) + cached
      state.outputTokens = numericField(usage?.output_tokens) ?? 0
      return null
    }
    case 'content_block_start': {
      const block = parsed.content_block as Record<string, unknown> | undefined
      if (!block || block.type !== 'tool_use') return null
      const wireIndex = numericField(parsed.index) ?? 0
      const index = resolveToolCallIndex(state.toolCallIndexes, wireIndex)
      const delta: ChatCompletionToolCallDelta = {
        index,
        function: {
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments: '',
        },
      }
      if (typeof block.id === 'string') delta.id = block.id
      return { updates: [], toolCalls: [delta] }
    }
    case 'content_block_delta': {
      const delta = parsed.delta as Record<string, unknown> | undefined
      if (!delta) return null
      if (delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : ''
        if (text === '') return null
        return { updates: [{ type: 'content', chunk: text }], toolCalls: [] }
      }
      if (delta.type === 'thinking_delta') {
        const text = typeof delta.thinking === 'string' ? delta.thinking : ''
        if (text === '') return null
        return { updates: [{ type: 'reasoning', chunk: text }], toolCalls: [] }
      }
      if (delta.type === 'input_json_delta') {
        const partial =
          typeof delta.partial_json === 'string' ? delta.partial_json : ''
        if (partial === '') return null
        return {
          updates: [],
          toolCalls: [
            {
              index: resolveToolCallIndex(
                state.toolCallIndexes,
                numericField(parsed.index) ?? 0
              ),
              function: { arguments: partial },
            },
          ],
        }
      }
      return null
    }
    case 'message_delta': {
      const delta = parsed.delta as Record<string, unknown> | undefined
      const usage = parsed.usage as Record<string, unknown> | undefined
      state.outputTokens =
        numericField(usage?.output_tokens) ?? state.outputTokens
      const usageFrame = usageResult(state.inputTokens, state.outputTokens)
      return {
        updates: [],
        toolCalls: [],
        ...(usageFrame ? { usage: usageFrame } : {}),
        finishReason: messagesFinishReason(delta?.stop_reason),
      }
    }
    case 'message_stop':
      return { updates: [], toolCalls: [], done: true }
    case 'error': {
      const failure = parsed.error as Record<string, unknown> | undefined
      const message =
        typeof failure?.message === 'string'
          ? failure.message
          : 'The upstream stream reported an error.'
      const code = typeof failure?.type === 'string' ? failure.type : undefined
      return {
        updates: [],
        toolCalls: [],
        error: { errorCode: code, errorMessage: message },
      }
    }
    default:
      return null
  }
}

/**
 * Creates the per-stream parser of one protocol. The parser owns the tiny bit
 * of state the protocols need — token usage arriving in separate frames and the
 * tool-call index of a content block — and returns `null` for frames the UI
 * does not consume. Chat streams keep the OpenAI chunk parser, so a parser is
 * only created for the Responses and Messages protocols.
 */
export function createPlaygroundProtocolStreamParser(
  protocol: PlaygroundProtocol
): PlaygroundProtocolStreamParser {
  if (protocol === 'responses') {
    const state: ResponsesStreamState = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallIndexes: new Map(),
    }
    return (eventName, data) => {
      const parsed = parseJsonObject(data)
      if (!parsed) return null
      const type =
        eventName || (typeof parsed.type === 'string' ? parsed.type : '')
      if (type === '') return null
      return parseResponsesEvent(type, parsed, state)
    }
  }

  if (protocol === 'messages') {
    const state: MessagesStreamState = {
      inputTokens: 0,
      outputTokens: 0,
      toolCallIndexes: new Map(),
    }
    return (eventName, data) => {
      const parsed = parseJsonObject(data)
      if (!parsed) return null
      const type =
        eventName || (typeof parsed.type === 'string' ? parsed.type : '')
      if (type === '') return null
      return parseMessagesEvent(type, parsed, state)
    }
  }

  return () => null
}

function parseJsonObject(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
