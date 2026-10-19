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
  DEFAULT_DEVELOPER_OPTIONS,
  PLAYGROUND_DEVELOPER_DESCRIPTION_MAX_BYTES,
  PLAYGROUND_DEVELOPER_ERRORS,
  PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH,
  PLAYGROUND_DEVELOPER_OPTIONS_MAX_BYTES,
  PLAYGROUND_DEVELOPER_SCHEMA_MAX_BYTES,
  PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT,
} from '../../constants'
import type {
  ChatCompletionJsonSchema,
  ChatCompletionResponseFormat,
  ChatCompletionTool,
  PlaygroundDeveloperOptions,
  PlaygroundDeveloperResponseFormat,
  PlaygroundDeveloperToolChoice,
} from '../../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Byte size of one JSON value as it would travel in a request. */
export function jsonByteSize(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value) ?? '')
}

function normalizeToolChoice(value: unknown): PlaygroundDeveloperToolChoice {
  if (value === 'auto' || value === 'none' || value === 'required') {
    return value
  }
  return ''
}

function normalizeTool(value: unknown): ChatCompletionTool | null {
  if (!isRecord(value) || value.type !== 'function') return null
  const fn = isRecord(value.function) ? value.function : null
  if (!fn) return null
  const name = typeof fn.name === 'string' ? fn.name.trim() : ''
  if (!name) return null
  const tool: ChatCompletionTool = { type: 'function', function: { name } }
  if (typeof fn.description === 'string' && fn.description) {
    tool.function.description = fn.description
  }
  if (isRecord(fn.parameters)) {
    tool.function.parameters = fn.parameters
  }
  if (fn.strict === true) {
    tool.function.strict = true
  }
  return tool
}

function normalizeJsonSchema(value: unknown): ChatCompletionJsonSchema | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  // A named schema without a schema body cannot validate anything, so it
  // degrades to the plain text format instead of being injected broken.
  if (!name || !isRecord(value.schema)) return null
  const schema: ChatCompletionJsonSchema = { name, schema: value.schema }
  if (typeof value.description === 'string' && value.description) {
    schema.description = value.description
  }
  if (value.strict === true) {
    schema.strict = true
  }
  return schema
}

function normalizeResponseFormat(
  value: unknown
): PlaygroundDeveloperResponseFormat {
  if (!isRecord(value)) return { type: 'text' }
  if (value.type === 'json_object') return { type: 'json_object' }
  if (value.type !== 'json_schema') return { type: 'text' }
  // The server stores the OpenAI wire shape (`json_schema`); the local shape
  // is camelCase, so both spellings are read back.
  const jsonSchema = normalizeJsonSchema(value.json_schema ?? value.jsonSchema)
  if (!jsonSchema) return { type: 'text' }
  return { type: 'json_schema', jsonSchema }
}

/**
 * Turns a stored or server-read developer settings value into the local shape.
 * The stored value is trusted for its shape (the server validated it on write),
 * but a legacy, edited or partially written object must never make the
 * conversation unusable, so every unusable field degrades to its disabled
 * default instead of rejecting the whole conversation.
 */
export function normalizeDeveloperOptions(
  value: unknown
): PlaygroundDeveloperOptions {
  if (!isRecord(value)) {
    return { ...DEFAULT_DEVELOPER_OPTIONS, tools: [] }
  }
  const rawTools = Array.isArray(value.tools) ? value.tools : []
  const tools = rawTools
    .map(normalizeTool)
    .filter((tool): tool is ChatCompletionTool => tool !== null)
    .slice(0, PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT)
  return {
    enabled: value.enabled === true,
    tools,
    toolChoice:
      tools.length > 0
        ? normalizeToolChoice(value.tool_choice ?? value.toolChoice)
        : '',
    responseFormat: normalizeResponseFormat(
      value.response_format ?? value.responseFormat
    ),
  }
}

/** One tool as it travels in a request; absent optional fields stay absent. */
function serializeTool(tool: ChatCompletionTool): ChatCompletionTool {
  const fn: ChatCompletionTool['function'] = { name: tool.function.name }
  if (tool.function.description) fn.description = tool.function.description
  if (tool.function.parameters) fn.parameters = tool.function.parameters
  if (tool.function.strict) fn.strict = true
  return { type: 'function', function: fn }
}

/**
 * The OpenAI wire shape of one JSON Schema response format. The schema body is
 * written verbatim: the gateway validates its size but never rewrites the
 * keywords the provider defines.
 */
export function serializeResponseFormat(
  format: PlaygroundDeveloperResponseFormat
): ChatCompletionResponseFormat {
  if (format.type !== 'json_schema' || !format.jsonSchema) {
    return { type: format.type === 'json_object' ? 'json_object' : 'text' }
  }
  const json_schema: ChatCompletionResponseFormat['json_schema'] = {
    name: format.jsonSchema.name,
    schema: format.jsonSchema.schema,
  }
  if (format.jsonSchema.description)
    json_schema.description = format.jsonSchema.description
  if (format.jsonSchema.strict) json_schema.strict = true
  return { type: 'json_schema', json_schema }
}

/**
 * The complete developer settings object in the server wire shape (the OpenAI
 * shape the session API stores). Definitions are sent even while disabled so
 * switching the feature off never loses them.
 */
export function serializeDeveloperOptions(
  options: PlaygroundDeveloperOptions
): Record<string, unknown> {
  const payload: Record<string, unknown> = { enabled: options.enabled }
  if (options.tools.length > 0) {
    payload.tools = options.tools.map(serializeTool)
  }
  if (options.tools.length > 0 && options.toolChoice) {
    payload.tool_choice = options.toolChoice
  }
  if (options.responseFormat.type !== 'text') {
    payload.response_format = serializeResponseFormat(options.responseFormat)
  }
  return payload
}

/**
 * The request fields one send injects, or an empty object while the settings
 * are disabled or carry nothing to inject. Tools and the tool choice travel
 * together: a choice without a tool describes nothing to call.
 */
export function buildDeveloperRequestFields(
  options: PlaygroundDeveloperOptions | null | undefined
): {
  tools?: ChatCompletionTool[]
  tool_choice?: Exclude<PlaygroundDeveloperToolChoice, ''>
  response_format?: ChatCompletionResponseFormat
} {
  if (!options?.enabled) return {}
  const fields: ReturnType<typeof buildDeveloperRequestFields> = {}
  if (options.tools.length > 0) {
    fields.tools = options.tools.map(serializeTool)
    if (options.toolChoice) fields.tool_choice = options.toolChoice
  }
  if (options.responseFormat.type !== 'text') {
    fields.response_format = serializeResponseFormat(options.responseFormat)
  }
  return fields
}

/**
 * Parses the JSON Schema text of the editor. A schema must be a JSON object:
 * arrays and scalars would be rejected by the server, so the editor keeps the
 * previous schema until the text is valid.
 */
export function parseJsonSchemaText(
  text: string
): { value: Record<string, unknown> } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: PLAYGROUND_DEVELOPER_ERRORS.INVALID_SCHEMA }
  }
  if (!isRecord(parsed)) {
    return { error: PLAYGROUND_DEVELOPER_ERRORS.INVALID_SCHEMA }
  }
  return { value: parsed }
}

/**
 * First problem of one developer settings object, as the i18n key of the
 * message to show, or null while the object can be saved and sent. The server
 * enforces the same contract; this keeps the editor from offering a save the
 * server would reject.
 */
export function validateDeveloperOptions(
  options: PlaygroundDeveloperOptions
): string | null {
  if (options.tools.length > PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT) {
    return PLAYGROUND_DEVELOPER_ERRORS.TOO_MANY_TOOLS
  }
  const names = new Set<string>()
  for (const tool of options.tools) {
    const name = tool.function.name
    if (!name) return PLAYGROUND_DEVELOPER_ERRORS.NAME_REQUIRED
    if (name.length > PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH) {
      return PLAYGROUND_DEVELOPER_ERRORS.NAME_TOO_LONG
    }
    if (names.has(name)) return PLAYGROUND_DEVELOPER_ERRORS.DUPLICATE_NAME
    names.add(name)
    const description = tool.function.description ?? ''
    if (
      utf8ByteLength(description) > PLAYGROUND_DEVELOPER_DESCRIPTION_MAX_BYTES
    ) {
      return PLAYGROUND_DEVELOPER_ERRORS.DESCRIPTION_TOO_LONG
    }
    if (
      tool.function.parameters &&
      jsonByteSize(tool.function.parameters) >
        PLAYGROUND_DEVELOPER_SCHEMA_MAX_BYTES
    ) {
      return PLAYGROUND_DEVELOPER_ERRORS.SCHEMA_TOO_LARGE
    }
  }
  const format = options.responseFormat
  if (format.type === 'json_schema') {
    if (!format.jsonSchema?.name.trim()) {
      return PLAYGROUND_DEVELOPER_ERRORS.RESPONSE_NAME_REQUIRED
    }
    if (format.jsonSchema.name.length > PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH) {
      return PLAYGROUND_DEVELOPER_ERRORS.NAME_TOO_LONG
    }
    if (
      jsonByteSize(format.jsonSchema.schema) >
      PLAYGROUND_DEVELOPER_SCHEMA_MAX_BYTES
    ) {
      return PLAYGROUND_DEVELOPER_ERRORS.SCHEMA_TOO_LARGE
    }
  }
  if (
    jsonByteSize(serializeDeveloperOptions(options)) >
    PLAYGROUND_DEVELOPER_OPTIONS_MAX_BYTES
  ) {
    return PLAYGROUND_DEVELOPER_ERRORS.OPTIONS_TOO_LARGE
  }
  return null
}

/**
 * Whether the settings inject anything into a request. The status dot and the
 * response preview both key off this, so "enabled" alone never claims an
 * effect while nothing is defined.
 */
export function developerOptionsActive(
  options: PlaygroundDeveloperOptions
): boolean {
  return (
    options.enabled &&
    (options.tools.length > 0 || options.responseFormat.type !== 'text')
  )
}
