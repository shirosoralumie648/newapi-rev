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
import { ERROR_MESSAGES, PLAYGROUND_REQUEST_ID_HEADER } from '../../constants'
import type {
  ChatCompletionChunk,
  ChatCompletionToolCallDelta,
  MessageUsage,
} from '../../types'
import { toMessageUsage } from '../message/message-usage-utils'

const STREAM_DONE_MESSAGE = '[DONE]'
const STREAM_CLOSED_READY_STATE = 2

export type StreamUpdateType = 'reasoning' | 'content'

export type StreamMessageUpdate = {
  type: StreamUpdateType
  chunk: string
}

export type StreamChunkParseResult = {
  updates: StreamMessageUpdate[]
  toolCalls: ChatCompletionToolCallDelta[]
  usage?: MessageUsage
}

type StreamErrorPayload = {
  error?: {
    code?: string
    message?: string
  }
}

export type StreamErrorDetails = {
  errorCode?: string
  errorMessage: string
}

export function parseStreamErrorDetails(data?: string): StreamErrorDetails {
  const fallbackMessage = data || ERROR_MESSAGES.API_REQUEST_ERROR

  if (!data) {
    return { errorMessage: fallbackMessage }
  }

  try {
    const parsed = JSON.parse(data) as StreamErrorPayload

    if (!parsed?.error) {
      return { errorMessage: fallbackMessage }
    }

    return {
      errorCode: parsed.error.code || undefined,
      errorMessage: parsed.error.message || fallbackMessage,
    }
  } catch {
    return { errorMessage: fallbackMessage }
  }
}

/**
 * Parse one SSE chunk. Text and reasoning updates flow into the assistant
 * content; tool call fragments are kept separate because they are merged by
 * stream index before they become stored calls. The final frame carries the
 * usage of the whole request, so it is reported even when it has no choices.
 */
export function parseStreamChunk(data: string): StreamChunkParseResult {
  const chunk = JSON.parse(data) as ChatCompletionChunk
  const usage = toMessageUsage(chunk.usage)
  const delta = chunk.choices?.[0]?.delta

  if (!delta) {
    return { updates: [], toolCalls: [], usage }
  }

  const updates: StreamMessageUpdate[] = []
  const reasoning = delta.reasoning_content ?? delta.reasoning

  if (reasoning) {
    updates.push({ type: 'reasoning', chunk: reasoning })
  }

  if (delta.content) {
    updates.push({ type: 'content', chunk: delta.content })
  }

  return { updates, toolCalls: delta.tool_calls ?? [], usage }
}

/**
 * The relay request id the response header carries. The SSE transport exposes
 * its XMLHttpRequest, so the header is readable once the response started; a
 * transport without one (or a cross-origin response without the header
 * exposed) simply yields no id.
 */
export function getStreamResponseRequestId(
  source: unknown
): string | undefined {
  const xhr = (
    source as {
      xhr?: { getResponseHeader?: (name: string) => string | null }
    }
  ).xhr
  const value = xhr?.getResponseHeader?.(PLAYGROUND_REQUEST_ID_HEADER)
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function isStreamDoneMessage(data: string): boolean {
  return data === STREAM_DONE_MESSAGE
}

export function isStreamClosedReadyState(readyState?: number): boolean {
  return readyState === STREAM_CLOSED_READY_STATE
}

export function getStreamReadyStateError(
  eventReadyState: number | undefined,
  source: unknown
): string | null {
  const status = (source as { status?: number }).status

  if (
    eventReadyState !== undefined &&
    eventReadyState >= STREAM_CLOSED_READY_STATE &&
    status !== undefined &&
    status !== 200
  ) {
    return `HTTP ${status}: ${ERROR_MESSAGES.CONNECTION_CLOSED}`
  }

  return null
}
