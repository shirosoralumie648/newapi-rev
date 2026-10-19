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
import type { PlaygroundWebSearchResponse } from '../../api'
import {
  MESSAGE_ROLES,
  MESSAGE_STATUS,
  PLAYGROUND_TOOL_EXECUTION_ERRORS,
} from '../../constants'
import type { Message, MessageToolCall, MessageVersion } from '../../types'
import type { KnowledgeSearchGroup } from '../knowledge/retrieval'
import {
  getMessageToolCalls,
  getPendingToolCalls,
} from '../message/message-tool-call-utils'
import { findMCPToolRef, type PlaygroundMCPToolRef } from './mcp-tools'

/** Tool names the Playground can answer without a manual result. */
export const EXECUTABLE_TOOL_NAMES = [
  'web_search',
  'get_time',
  'kb_search',
] as const

export type ExecutableToolKind = (typeof EXECUTABLE_TOOL_NAMES)[number]

/** The stored JSON is never evaluated; only these arguments are read. */
export type ToolCallArguments = Record<string, unknown>

/** Marker appended to a result cut to the server's byte budget. */
export const TOOL_RESULT_TRUNCATED_MARKER = '\n[tool result truncated]'

/** A validation or provider failure whose sentence is an i18n key. */
export class ToolExecutionError extends Error {
  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'ToolExecutionError'
  }
}

export function getExecutableToolKind(name: string): ExecutableToolKind | null {
  const normalized = name.trim().toLowerCase()
  return EXECUTABLE_TOOL_NAMES.find((tool) => tool === normalized) ?? null
}

/**
 * Parse the raw function arguments the model produced. An empty argument
 * string means "no parameters"; a non-object JSON value is invalid because
 * every executable tool reads named fields.
 */
export function parseToolArguments(raw: string): ToolCallArguments | null {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as ToolCallArguments
  } catch {
    return null
  }
}

export function getStringArgument(
  args: ToolCallArguments,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function getNumberArgument(
  args: ToolCallArguments,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function takeUtf8Bytes(value: string, maxBytes: number): string {
  let result = ''
  let used = 0
  for (const character of value) {
    const bytes = utf8ByteLength(character)
    if (used + bytes > maxBytes) break
    result += character
    used += bytes
  }
  return result
}

/**
 * Keep an automatically produced result inside the byte budget the server
 * enforces for a tool result. The cut is code-point safe, so a multibyte
 * character is never split, and the marker explains the shortening to the
 * model instead of silently dropping content.
 */
export function truncateToolResultBytes(
  value: string,
  maxBytes: number
): string {
  const limit = Math.max(0, Math.floor(maxBytes))
  if (utf8ByteLength(value) <= limit) return value
  const markerBytes = utf8ByteLength(TOOL_RESULT_TRUNCATED_MARKER)
  if (limit <= markerBytes) return takeUtf8Bytes(value, limit)
  return (
    takeUtf8Bytes(value, limit - markerBytes) + TOOL_RESULT_TRUNCATED_MARKER
  )
}

/**
 * Current time from the browser clock, in the requested IANA time zone (the
 * runtime zone when none is named). This is protocol content for the model,
 * not user interface text, so it stays English.
 */
export function buildTimeToolResult(
  now: Date = new Date(),
  timeZone?: string
): string {
  const resolvedZone =
    timeZone?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: resolvedZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
      timeZoneName: 'longOffset',
    })
  } catch {
    throw new ToolExecutionError(
      PLAYGROUND_TOOL_EXECUTION_ERRORS.INVALID_TIME_ZONE
    )
  }

  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
  return JSON.stringify({
    iso: now.toISOString(),
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    timezone: resolvedZone,
    weekday: parts.weekday ?? '',
    utc_offset: parts.timeZoneName ?? '',
    unix_seconds: Math.floor(now.getTime() / 1000),
  })
}

/** One normalized web-search response as the model-facing tool result. */
export function buildWebSearchToolResult(
  response: PlaygroundWebSearchResponse
): string {
  return JSON.stringify({
    query: response.query,
    provider: response.provider || undefined,
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
  })
}

/**
 * Merged knowledge hits as the model-facing tool result. Citation numbers
 * mirror the numbered block the retrieval injection uses for a user turn.
 */
export function buildKnowledgeSearchToolResult(
  query: string,
  result: KnowledgeSearchGroup
): string {
  return JSON.stringify({
    query,
    results: result.hits.map((hit, index) => ({
      citation: index + 1,
      knowledge_base: hit.knowledgeBaseName,
      file: hit.filename,
      chunk: hit.chunkIndex,
      score: Number(hit.score.toFixed(4)),
      text: hit.text,
      ...(hit.truncated ? { truncated: true } : {}),
    })),
    ...(result.staleDocuments.length > 0
      ? {
          stale_documents: result.staleDocuments.map((document) => ({
            file: document.filename,
            embedding_model: document.embeddingModel,
          })),
        }
      : {}),
  })
}

/**
 * Pending calls of one message that map to an executable tool: a built-in
 * function or a tool of a global MCP connection the account may call right
 * now. A call with a malformed name or an unknown function stays pending for
 * the manual path.
 */
export function getPendingExecutableToolCalls(
  message: Message,
  mcpTools: readonly PlaygroundMCPToolRef[] = []
): MessageToolCall[] {
  return getPendingToolCalls(message).filter(
    (call) =>
      getExecutableToolKind(call.name) !== null ||
      findMCPToolRef(call.name, mcpTools) !== null
  )
}

/**
 * Number of assistant tool-call rounds since the newest user turn. A manual
 * continuation adds a new assistant reply, so the bounded loop counts every
 * reply that requested tools instead of only the first one.
 */
export function countToolRoundsSinceLastUser(messages: Message[]): number {
  let rounds = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.from === MESSAGE_ROLES.USER) break
    if (
      message.from === MESSAGE_ROLES.ASSISTANT &&
      getMessageToolCalls(message).length > 0
    ) {
      rounds += 1
    }
  }
  return rounds
}

export function isToolRoundLimitReached(
  messages: Message[],
  maxRounds: number
): boolean {
  return countToolRoundsSinceLastUser(messages) >= maxRounds
}

/** The reply a continuation can follow: a settled assistant tool-call turn. */
export function getToolLoopMessage(messages: Message[]): Message | null {
  const last = messages.at(-1)
  if (
    !last ||
    last.from !== MESSAGE_ROLES.ASSISTANT ||
    last.status === MESSAGE_STATUS.LOADING ||
    last.status === MESSAGE_STATUS.STREAMING ||
    last.status === MESSAGE_STATUS.ERROR
  ) {
    return null
  }
  if (getMessageToolCalls(last).length === 0) return null
  return last
}

export function toolCallVersionKey(
  message: Message,
  version: MessageVersion
): string {
  return `${message.key}:${version.id}`
}

/** Identifies one call of one version for transient execution state. */
export function toolCallExecutionKey(
  message: Message,
  version: MessageVersion,
  toolCallId: string
): string {
  return `${toolCallVersionKey(message, version)}:${toolCallId}`
}
