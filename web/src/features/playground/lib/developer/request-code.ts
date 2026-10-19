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
  PLAYGROUND_ANTHROPIC_VERSION,
  PLAYGROUND_PROTOCOL_API_PATHS,
} from '../../constants'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ContentPart,
  PlaygroundProtocol,
} from '../../types'
import { buildPlaygroundProtocolRequest } from '../protocol/protocol-payload'

/**
 * The OpenAI-compatible endpoint a chat export targets. The Playground itself
 * posts to the `/pg` bridge; the exported code always uses the public API path
 * so it can run outside the browser with a real token.
 */
export const PLAYGROUND_REQUEST_API_PATH = PLAYGROUND_PROTOCOL_API_PATHS.chat

/**
 * Placeholder key written into every export. Exports never read, render or
 * embed the signed-in user's real token.
 */
export const PLAYGROUND_REQUEST_API_KEY = '$NEWAPI_API_KEY'

export type PlaygroundRequestCodeTab = 'messages' | 'curl' | 'python' | 'node'

export const PLAYGROUND_REQUEST_CODE_TABS: readonly PlaygroundRequestCodeTab[] =
  ['messages', 'curl', 'python', 'node']

/**
 * The final payload of the most recent send plus when it was built. It only
 * lives in component state; nothing is persisted and a reload clears it.
 */
export interface PlaygroundCapturedRequest {
  payload: ChatCompletionRequest
  capturedAt: number
  /**
   * Wire protocol of this send. Absent means chat, which keeps captures made
   * before the protocol selector usable.
   */
  protocol?: PlaygroundProtocol
  /**
   * Raw reply body (non-streaming) or SSE transcript (streaming), bounded and
   * display-only. Absent until the transport has received it.
   */
  rawResponse?: string
}

/** One attachment whose bytes were replaced by a file placeholder. */
export interface PlaygroundRequestAttachment {
  /** Stable `attachment://…` URL shown in the Messages JSON payload. */
  placeholder: string
  /** File name the Python/Node exports read from disk. */
  filename: string
  mediaType: string
}

/** A redacted payload plus the attachments it references by placeholder. */
export interface PlaygroundRequestRedaction {
  payload: ChatCompletionRequest
  attachments: PlaygroundRequestAttachment[]
}

const ATTACHMENT_PLACEHOLDER_PREFIX = 'attachment://'
const DATA_URL_PATTERN = /^data:([^;,]+)[^,]*,/i
const FALLBACK_BASE_URL = 'https://your-new-api-host'

function attachmentExtension(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.split('+')[0]?.toLowerCase()
  if (!subtype) return 'bin'
  if (subtype === 'jpeg') return 'jpg'
  return subtype.replace(/[^a-z0-9]/g, '') || 'bin'
}

function createAttachment(
  mediaType: string,
  index: number
): PlaygroundRequestAttachment {
  const filename = `attachment-${index}.${attachmentExtension(mediaType)}`
  return {
    placeholder: `${ATTACHMENT_PLACEHOLDER_PREFIX}${filename}`,
    filename,
    mediaType,
  }
}

/**
 * Replaces one inline `data:` URL with a stable placeholder. Remote image URLs
 * are left untouched: they carry no bytes and the user already has them.
 */
function redactImageUrl(
  url: string,
  attachmentsByUrl: Map<string, PlaygroundRequestAttachment>,
  attachments: PlaygroundRequestAttachment[]
): string {
  const match = DATA_URL_PATTERN.exec(url)
  if (!match) return url
  const existing = attachmentsByUrl.get(url)
  if (existing) return existing.placeholder
  const attachment = createAttachment(
    match[1] || 'application/octet-stream',
    attachments.length + 1
  )
  attachmentsByUrl.set(url, attachment)
  attachments.push(attachment)
  return attachment.placeholder
}

function redactContentParts(
  parts: ContentPart[],
  attachmentsByUrl: Map<string, PlaygroundRequestAttachment>,
  attachments: PlaygroundRequestAttachment[]
): ContentPart[] {
  return parts.map((part) => {
    if (!part.image_url) return { ...part }
    return {
      ...part,
      image_url: {
        url: redactImageUrl(part.image_url.url, attachmentsByUrl, attachments),
      },
    }
  })
}

function redactMessage(
  message: ChatCompletionMessage,
  attachmentsByUrl: Map<string, PlaygroundRequestAttachment>,
  attachments: PlaygroundRequestAttachment[]
): ChatCompletionMessage {
  if (typeof message.content === 'string') return { ...message }
  return {
    ...message,
    content: redactContentParts(message.content, attachmentsByUrl, attachments),
  }
}

/**
 * Copies the payload with every inline base64 attachment replaced by an
 * `attachment://` placeholder, and reports the file each placeholder stands
 * for. The wrapper never mutates the captured payload.
 */
export function redactPlaygroundRequest(
  payload: ChatCompletionRequest
): PlaygroundRequestRedaction {
  const attachmentsByUrl = new Map<string, PlaygroundRequestAttachment>()
  const attachments: PlaygroundRequestAttachment[] = []
  return {
    payload: {
      ...payload,
      messages: payload.messages.map((message) =>
        redactMessage(message, attachmentsByUrl, attachments)
      ),
    },
    attachments,
  }
}

/** Normalizes the site origin into the base URL the exports use. */
export function normalizePlaygroundRequestBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed || FALLBACK_BASE_URL
}

export function playgroundRequestEndpoint(
  baseUrl: string,
  protocol: PlaygroundProtocol = 'chat'
): string {
  return `${normalizePlaygroundRequestBaseUrl(baseUrl)}${PLAYGROUND_PROTOCOL_API_PATHS[protocol]}`
}

/** Site origin of the running console; empty outside the browser. */
export function resolvePlaygroundRequestBaseUrl(): string {
  if (typeof window === 'undefined') return ''
  return window.location.origin
}

/**
 * Redacts attachments and converts the chat payload into the exported
 * protocol's wire body. Chat keeps the payload unchanged.
 */
function protocolRequestBody(
  payload: ChatCompletionRequest,
  protocol: PlaygroundProtocol
): {
  body: Record<string, unknown>
  attachments: PlaygroundRequestAttachment[]
} {
  const { payload: redacted, attachments } = redactPlaygroundRequest(payload)
  return {
    body: buildPlaygroundProtocolRequest(redacted, protocol).body,
    attachments,
  }
}

/** Messages JSON tab: the exact wire payload with attachments redacted. */
export function buildPlaygroundMessagesJson(
  payload: ChatCompletionRequest,
  protocol: PlaygroundProtocol = 'chat'
): string {
  return JSON.stringify(protocolRequestBody(payload, protocol).body, null, 2)
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function groupFieldNotes(
  payload: ChatCompletionRequest,
  comment: string,
  protocol: PlaygroundProtocol = 'chat'
): string[] {
  if (payload.group === undefined) return []
  return [
    `${comment} "group" is a Playground-only routing field.`,
    `${comment} ${PLAYGROUND_PROTOCOL_API_PATHS[protocol]} selects the group from the API token instead,`,
    `${comment} so remove "group" if the endpoint rejects it.`,
  ]
}

function protocolAuthHeaderLines(protocol: PlaygroundProtocol): string[] {
  if (protocol === 'messages') {
    return [
      `  -H "x-api-key: ${PLAYGROUND_REQUEST_API_KEY}" \\`,
      `  -H "anthropic-version: ${PLAYGROUND_ANTHROPIC_VERSION}" \\`,
    ]
  }
  return [`  -H "Authorization: Bearer ${PLAYGROUND_REQUEST_API_KEY}" \\`]
}

/** cURL tab: a runnable command with a placeholder key and redacted body. */
export function buildPlaygroundCurlCode(
  payload: ChatCompletionRequest,
  baseUrl: string,
  protocol: PlaygroundProtocol = 'chat'
): string {
  const { body, attachments } = protocolRequestBody(payload, protocol)
  const lines = [
    '# New API Playground request.',
    '# It targets the selected API protocol with the placeholder key',
    `# ${PLAYGROUND_REQUEST_API_KEY}; replace it with a token of your own.`,
    ...groupFieldNotes(payload, '#', protocol),
  ]
  if (attachments.length > 0) {
    lines.push(
      `# ${attachments.length} attachment(s) are not embedded in this snippet;`,
      '# replace each attachment:// URL with a data URL or a reachable image URL.'
    )
  }
  lines.push(
    `curl ${shellSingleQuote(playgroundRequestEndpoint(baseUrl, protocol))} \\`,
    ...protocolAuthHeaderLines(protocol),
    '  -H "Content-Type: application/json" \\',
    `  -d ${shellSingleQuote(JSON.stringify(body, null, 2))}`
  )
  return lines.join('\n')
}

type LiteralLanguage = 'python' | 'javascript'

interface LiteralOptions {
  attachments: Map<string, PlaygroundRequestAttachment>
  attachmentExpression: (attachment: PlaygroundRequestAttachment) => string
  indentUnit: string
  language: LiteralLanguage
}

function indentBlock(depth: number, options: LiteralOptions): string {
  return options.indentUnit.repeat(Math.max(0, depth))
}

function renderArrayBlocks(
  blocks: string[],
  depth: number,
  options: LiteralOptions
): string {
  if (blocks.length === 0) return '[]'
  const lines = blocks.map(
    (block) => `${indentBlock(depth + 1, options)}${block},`
  )
  return ['[', ...lines, `${indentBlock(depth, options)}]`].join('\n')
}

function renderObjectFields(
  fields: ReadonlyArray<readonly [string, string]>,
  depth: number,
  options: LiteralOptions
): string {
  if (fields.length === 0) return '{}'
  const lines = fields.map(
    ([key, value]) =>
      `${indentBlock(depth + 1, options)}${JSON.stringify(key)}: ${value},`
  )
  return ['{', ...lines, `${indentBlock(depth, options)}}`].join('\n')
}

function renderLiteral(
  value: unknown,
  depth: number,
  options: LiteralOptions
): string {
  if (value === null || value === undefined) {
    return options.language === 'python' ? 'None' : 'null'
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0'
  }
  if (typeof value === 'boolean') {
    if (options.language === 'python') return value ? 'True' : 'False'
    return String(value)
  }
  if (Array.isArray(value)) {
    return renderArrayBlocks(
      value.map((item) => renderLiteral(item, depth + 1, options)),
      depth,
      options
    )
  }
  if (typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, fieldValue]) => fieldValue !== undefined)
      .map(
        ([key, fieldValue]) =>
          [key, renderLiteral(fieldValue, depth + 1, options)] as const
      )
    return renderObjectFields(fields, depth, options)
  }
  return options.language === 'python' ? 'None' : 'null'
}

function renderContentParts(
  parts: ContentPart[],
  depth: number,
  options: LiteralOptions
): string {
  const blocks = parts.map((part) => {
    const fields: Array<[string, string]> = [
      ['type', JSON.stringify(part.type)],
    ]
    if (part.text !== undefined) {
      fields.push(['text', JSON.stringify(part.text)])
    }
    if (part.image_url) {
      const attachment = options.attachments.get(part.image_url.url)
      const url = attachment
        ? options.attachmentExpression(attachment)
        : JSON.stringify(part.image_url.url)
      fields.push([
        'image_url',
        renderObjectFields([['url', url]], depth + 2, options),
      ])
    }
    return renderObjectFields(fields, depth + 1, options)
  })
  return renderArrayBlocks(blocks, depth, options)
}

function renderMessage(
  message: ChatCompletionMessage,
  depth: number,
  options: LiteralOptions
): string {
  const fields: Array<[string, string]> = [
    ['role', JSON.stringify(message.role)],
  ]
  if (typeof message.content === 'string') {
    fields.push(['content', JSON.stringify(message.content)])
  } else {
    fields.push([
      'content',
      renderContentParts(message.content, depth + 1, options),
    ])
  }
  if (message.tool_calls) {
    fields.push([
      'tool_calls',
      renderLiteral(message.tool_calls, depth + 1, options),
    ])
  }
  if (message.tool_call_id !== undefined) {
    fields.push(['tool_call_id', JSON.stringify(message.tool_call_id)])
  }
  return renderObjectFields(fields, depth, options)
}

function renderMessagesArray(
  payload: ChatCompletionRequest,
  options: LiteralOptions
): string {
  const blocks = payload.messages.map((message) =>
    renderMessage(message, 1, options)
  )
  return renderArrayBlocks(blocks, 0, options)
}

function optionalChatParameters(
  payload: ChatCompletionRequest
): Array<[string, number | string]> {
  const candidates: Array<[string, number | string | undefined]> = [
    ['temperature', payload.temperature],
    ['top_p', payload.top_p],
    ['max_tokens', payload.max_tokens],
    ['frequency_penalty', payload.frequency_penalty],
    ['presence_penalty', payload.presence_penalty],
    ['seed', payload.seed],
    ['reasoning_effort', payload.reasoning_effort],
  ]
  return candidates.filter(
    (candidate): candidate is [string, number | string] =>
      candidate[1] !== undefined
  )
}

function attachmentPlaceholderMap(
  attachments: PlaygroundRequestAttachment[]
): Map<string, PlaygroundRequestAttachment> {
  return new Map(
    attachments.map((attachment) => [attachment.placeholder, attachment])
  )
}

function pythonAttachmentExpression(
  attachment: PlaygroundRequestAttachment
): string {
  return `_attachment_data_url(${JSON.stringify(attachment.filename)}, ${JSON.stringify(attachment.mediaType)})`
}

function nodeAttachmentExpression(
  attachment: PlaygroundRequestAttachment
): string {
  return `attachmentDataUrl(${JSON.stringify(attachment.filename)}, ${JSON.stringify(attachment.mediaType)})`
}

/** Python tab: the same request through the official `openai` SDK. */
export function buildPlaygroundPythonCode(
  payload: ChatCompletionRequest,
  baseUrl: string
): string {
  const { payload: redacted, attachments } = redactPlaygroundRequest(payload)
  const options: LiteralOptions = {
    attachments: attachmentPlaceholderMap(attachments),
    attachmentExpression: pythonAttachmentExpression,
    indentUnit: '    ',
    language: 'python',
  }
  const lines = [
    '# New API Playground request for the OpenAI Python SDK.',
    '# pip install openai',
    ...groupFieldNotes(redacted, '#'),
  ]
  if (attachments.length > 0) {
    lines.push(
      '# Attachment bytes are read from local files at runtime;',
      '# no base64 is embedded in this snippet.'
    )
  }
  if (attachments.length > 0) {
    lines.push('import base64')
  }
  lines.push('from openai import OpenAI', '')
  if (attachments.length > 0) {
    lines.push(
      'def _attachment_data_url(path: str, media_type: str) -> str:',
      '    with open(path, "rb") as file:',
      '        encoded = base64.b64encode(file.read()).decode("ascii")',
      '    return f"data:{media_type};base64,{encoded}"',
      ''
    )
  }
  lines.push(
    'client = OpenAI(',
    `    api_key="${PLAYGROUND_REQUEST_API_KEY}",`,
    `    base_url="${normalizePlaygroundRequestBaseUrl(baseUrl)}/v1",`,
    ')',
    '',
    `messages = ${renderMessagesArray(redacted, options)}`,
    ''
  )
  const callArguments = [
    `    model=${JSON.stringify(payload.model)}`,
    '    messages=messages',
    `    stream=${payload.stream ? 'True' : 'False'}`,
    ...optionalChatParameters(payload).map(
      ([key, value]) => `    ${key}=${renderLiteral(value, 0, options)}`
    ),
  ]
  lines.push(
    'response = client.chat.completions.create(',
    ...callArguments.map((argument) => `${argument},`),
    ')',
    ''
  )
  if (payload.stream) {
    lines.push(
      'for chunk in response:',
      '    print(chunk.choices[0].delta.content or "", end="")'
    )
  } else {
    lines.push('print(response.choices[0].message.content or "")')
  }
  return lines.join('\n')
}

/** Node tab: the same request through the official `openai` SDK. */
export function buildPlaygroundNodeCode(
  payload: ChatCompletionRequest,
  baseUrl: string
): string {
  const { payload: redacted, attachments } = redactPlaygroundRequest(payload)
  const options: LiteralOptions = {
    attachments: attachmentPlaceholderMap(attachments),
    attachmentExpression: nodeAttachmentExpression,
    indentUnit: '  ',
    language: 'javascript',
  }
  const lines = [
    '// New API Playground request for the OpenAI Node SDK.',
    '// npm install openai',
    ...groupFieldNotes(redacted, '//'),
  ]
  if (attachments.length > 0) {
    lines.push(
      '// Attachment bytes are read from local files at runtime;',
      '// no base64 is embedded in this snippet.'
    )
  }
  if (attachments.length > 0) {
    lines.push('import fs from "node:fs";')
  }
  lines.push('import OpenAI from "openai";', '')
  if (attachments.length > 0) {
    lines.push(
      'function attachmentDataUrl(path, mediaType) {',
      '  return `data:${mediaType};base64,${fs.readFileSync(path).toString("base64")}`;',
      '}',
      ''
    )
  }
  lines.push(
    'const client = new OpenAI({',
    `  apiKey: "${PLAYGROUND_REQUEST_API_KEY}",`,
    `  baseURL: "${normalizePlaygroundRequestBaseUrl(baseUrl)}/v1",`,
    '});',
    '',
    `const messages = ${renderMessagesArray(redacted, options)}`,
    ''
  )
  const resultVariable = payload.stream ? 'stream' : 'response'
  const callArguments = [
    `  model: ${JSON.stringify(payload.model)}`,
    '  messages',
    `  stream: ${payload.stream ? 'true' : 'false'}`,
    ...optionalChatParameters(payload).map(
      ([key, value]) => `  ${key}: ${renderLiteral(value, 0, options)}`
    ),
  ]
  lines.push(
    `const ${resultVariable} = await client.chat.completions.create({`,
    ...callArguments.map((argument) => `${argument},`),
    '});',
    ''
  )
  if (payload.stream) {
    lines.push(
      'for await (const chunk of stream) {',
      '  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");',
      '}'
    )
  } else {
    lines.push('console.log(response.choices[0]?.message?.content ?? "");')
  }
  return lines.join('\n')
}

function protocolDisplayName(protocol: PlaygroundProtocol): string {
  if (protocol === 'responses') return 'OpenAI Responses API'
  if (protocol === 'messages') return 'Anthropic Messages API'
  return 'OpenAI-compatible API'
}

function protocolHeaders(protocol: PlaygroundProtocol): Record<string, string> {
  if (protocol === 'messages') {
    return {
      'x-api-key': PLAYGROUND_REQUEST_API_KEY,
      'anthropic-version': PLAYGROUND_ANTHROPIC_VERSION,
      'content-type': 'application/json',
    }
  }
  return {
    Authorization: `Bearer ${PLAYGROUND_REQUEST_API_KEY}`,
    'content-type': 'application/json',
  }
}

/**
 * Python tab of a non-chat protocol. The OpenAI SDKs only speak their own
 * protocol, so Responses and Messages exports use a plain HTTP request that
 * matches the API exactly.
 */
export function buildPlaygroundProtocolPythonCode(
  payload: ChatCompletionRequest,
  baseUrl: string,
  protocol: PlaygroundProtocol
): string {
  const { body, attachments } = protocolRequestBody(payload, protocol)
  const options: LiteralOptions = {
    attachments: attachmentPlaceholderMap(attachments),
    attachmentExpression: pythonAttachmentExpression,
    indentUnit: '    ',
    language: 'python',
  }
  const lines = [
    `# New API Playground request for the ${protocolDisplayName(protocol)}.`,
    '# pip install requests',
    ...groupFieldNotes(payload, '#', protocol),
  ]
  if (attachments.length > 0) {
    lines.push(
      '# Attachment bytes are read from local files at runtime;',
      '# no base64 is embedded in this snippet.',
      'import base64'
    )
  }
  lines.push('import requests', '')
  if (attachments.length > 0) {
    lines.push(
      'def _attachment_data_url(path: str, media_type: str) -> str:',
      '    with open(path, "rb") as file:',
      '        encoded = base64.b64encode(file.read()).decode("ascii")',
      '    return f"data:{media_type};base64,{encoded}"',
      ''
    )
  }
  lines.push(
    `body = ${renderLiteral(body, 0, options)}`,
    '',
    'response = requests.post(',
    `    ${JSON.stringify(playgroundRequestEndpoint(baseUrl, protocol))},`,
    `    headers=${renderLiteral(protocolHeaders(protocol), 0, options)},`,
    '    json=body,',
    ')',
    'print(response.text)'
  )
  return lines.join('\n')
}

/** Node tab of a non-chat protocol: a plain fetch request. */
export function buildPlaygroundProtocolNodeCode(
  payload: ChatCompletionRequest,
  baseUrl: string,
  protocol: PlaygroundProtocol
): string {
  const { body, attachments } = protocolRequestBody(payload, protocol)
  const options: LiteralOptions = {
    attachments: attachmentPlaceholderMap(attachments),
    attachmentExpression: nodeAttachmentExpression,
    indentUnit: '  ',
    language: 'javascript',
  }
  const lines = [
    `// New API Playground request for the ${protocolDisplayName(protocol)}.`,
    ...groupFieldNotes(payload, '//', protocol),
  ]
  if (attachments.length > 0) {
    lines.push(
      '// Attachment bytes are read from local files at runtime;',
      '// no base64 is embedded in this snippet.',
      'import fs from "node:fs";'
    )
  }
  if (attachments.length > 0) {
    lines.push(
      'function attachmentDataUrl(path, mediaType) {',
      '  return `data:${mediaType};base64,${fs.readFileSync(path).toString("base64")}`;',
      '}',
      ''
    )
  }
  lines.push(
    `const body = ${renderLiteral(body, 0, options)};`,
    '',
    `const response = await fetch(${JSON.stringify(playgroundRequestEndpoint(baseUrl, protocol))}, {`,
    `  method: "POST",`,
    `  headers: ${renderLiteral(protocolHeaders(protocol), 0, options)},`,
    '  body: JSON.stringify(body),',
    '});',
    '',
    'console.log(await response.text());'
  )
  return lines.join('\n')
}

/** Builds the clipboard text of one viewer tab. */
export function buildPlaygroundRequestCode(
  tab: PlaygroundRequestCodeTab,
  payload: ChatCompletionRequest,
  baseUrl: string,
  protocol: PlaygroundProtocol = 'chat'
): string {
  if (tab === 'curl') return buildPlaygroundCurlCode(payload, baseUrl, protocol)
  if (tab === 'python') {
    return protocol === 'chat'
      ? buildPlaygroundPythonCode(payload, baseUrl)
      : buildPlaygroundProtocolPythonCode(payload, baseUrl, protocol)
  }
  if (tab === 'node') {
    return protocol === 'chat'
      ? buildPlaygroundNodeCode(payload, baseUrl)
      : buildPlaygroundProtocolNodeCode(payload, baseUrl, protocol)
  }
  return buildPlaygroundMessagesJson(payload, protocol)
}
