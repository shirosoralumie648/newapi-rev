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
  API_ENDPOINTS,
  PLAYGROUND_MESSAGES_FALLBACK_MAX_TOKENS,
} from '../../constants'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponseFormat,
  ChatCompletionTool,
  ContentPart,
  PlaygroundProtocol,
} from '../../types'

/**
 * One wire request the workspace sends. The body is the protocol payload; the
 * endpoint is the Playground bridge that relays it through the canonical /v1
 * pipeline. The group travels in the body because the bridge consumes it
 * before the relay, exactly like the chat route.
 */
export interface PlaygroundProtocolRequest {
  protocol: PlaygroundProtocol
  endpoint: string
  body: Record<string, unknown>
}

/** Input item of the OpenAI Responses API. */
type ResponsesInputItem = Record<string, unknown>

/** Anthropic Messages content block. */
type MessagesContentBlock = Record<string, unknown>

/** Anthropic Messages wire message. */
interface MessagesWireMessage {
  role: 'user' | 'assistant'
  content: string | MessagesContentBlock[]
}

export interface PlaygroundResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  instructions?: string
  max_output_tokens?: number
  stream: boolean
  temperature?: number
  top_p?: number
  reasoning?: { effort: string }
  tools?: ResponsesTool[]
  tool_choice?: string
  text?: { format: ChatCompletionResponseFormat }
  group?: string
}

/** Responses tools flatten the chat function object onto the tool itself. */
interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export interface PlaygroundMessagesRequest {
  model: string
  messages: MessagesWireMessage[]
  system?: string
  max_tokens: number
  stream: boolean
  temperature?: number
  top_p?: number
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>
  tool_choice?:
    | { type: 'auto' | 'any' | 'none' }
    | { type: 'tool'; name: string }
  group?: string
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s

/** Text of one chat message; image parts are ignored. */
function messageText(message: ChatCompletionMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

/** System messages are lifted into the protocol-level instruction fields. */
function systemInstruction(messages: ChatCompletionMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map(messageText)
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

function conversationMessages(
  messages: ChatCompletionMessage[]
): ChatCompletionMessage[] {
  return messages.filter((message) => message.role !== 'system')
}

function parseToolCallInput(argumentsText: string): unknown {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    return parsed ?? {}
  } catch {
    return {}
  }
}

/** OpenAI image part → Responses input image part. */
function responsesImagePart(part: ContentPart): ResponsesInputItem {
  return { type: 'input_image', image_url: part.image_url?.url ?? '' }
}

function responsesMessageContent(message: ChatCompletionMessage): unknown {
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) =>
    part.type === 'text'
      ? {
          // An assistant turn is replayed as output text; user turns are input.
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: part.text ?? '',
        }
      : responsesImagePart(part)
  )
}

/**
 * Chat messages → Responses input items. An assistant turn that called tools
 * becomes standalone `function_call` items (the Responses shape) followed by
 * the assistant text that belongs to it, and a tool result becomes a
 * `function_call_output` item that carries the call id.
 */
function responsesInputItems(
  messages: ChatCompletionMessage[]
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: messageText(message),
      })
      continue
    }
    if (messageText(message) !== '') {
      items.push({
        role: message.role,
        content: responsesMessageContent(message),
      })
    }
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
    }
  }
  return items
}

/** OpenAI image part → Anthropic image block. */
function messagesImageBlock(part: ContentPart): MessagesContentBlock {
  const url = part.image_url?.url ?? ''
  const match = DATA_URL_PATTERN.exec(url)
  if (match) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] },
    }
  }
  return { type: 'image', source: { type: 'url', url } }
}

function messagesContentBlocks(
  message: ChatCompletionMessage
): MessagesContentBlock[] {
  const blocks: MessagesContentBlock[] = []
  if (typeof message.content === 'string') {
    if (message.content !== '')
      blocks.push({ type: 'text', text: message.content })
  } else {
    for (const part of message.content) {
      if (part.type === 'text') {
        if ((part.text ?? '') !== '')
          blocks.push({ type: 'text', text: part.text })
        continue
      }
      blocks.push(messagesImageBlock(part))
    }
  }
  if (message.role === 'assistant' && message.tool_calls) {
    for (const call of message.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseToolCallInput(call.function.arguments),
      })
    }
  }
  return blocks
}

function messagesToolResultBlocks(
  message: ChatCompletionMessage
): MessagesContentBlock[] {
  return [
    {
      type: 'tool_result',
      tool_use_id: message.tool_call_id ?? '',
      content: messageText(message),
    },
  ]
}

/**
 * Chat messages → Anthropic messages. A tool result is a user turn, so
 * consecutive turns with the same role are merged: the Anthropic endpoint
 * requires alternating roles and the workspace quote block may lead a user
 * turn.
 */
function messagesWireMessages(
  messages: ChatCompletionMessage[]
): MessagesWireMessage[] {
  const wire: MessagesWireMessage[] = []
  for (const message of messages) {
    const role =
      message.role === 'assistant' ? ('assistant' as const) : ('user' as const)
    const blocks =
      message.role === 'tool'
        ? messagesToolResultBlocks(message)
        : messagesContentBlocks(message)
    if (blocks.length === 0) continue
    const previous = wire.at(-1)
    if (previous?.role === role) {
      const previousBlocks =
        typeof previous.content === 'string'
          ? [{ type: 'text', text: previous.content }]
          : previous.content
      previous.content = [...previousBlocks, ...blocks]
      continue
    }
    wire.push({ role, content: blocks })
  }
  // A single text block reads better as a plain string, which is also the
  // shape a user-typed turn has.
  return wire.map((entry) => {
    const blocks = entry.content
    if (
      typeof blocks !== 'string' &&
      blocks.length === 1 &&
      blocks[0]?.type === 'text'
    ) {
      return { role: entry.role, content: String(blocks[0].text ?? '') }
    }
    return entry
  })
}

function messagesToolChoice(
  choice: ChatCompletionRequest['tool_choice']
): PlaygroundMessagesRequest['tool_choice'] {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  return undefined
}

function responsesTools(tools: ChatCompletionTool[]): ResponsesTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description !== undefined
      ? { description: tool.function.description }
      : {}),
    ...(tool.function.parameters !== undefined
      ? { parameters: tool.function.parameters }
      : {}),
    ...(tool.function.strict !== undefined
      ? { strict: tool.function.strict }
      : {}),
  }))
}

// Chat payload fields the protocol conversion does not carry. The list lives
// next to the conversion so forwarding a field and leaving it reported cannot
// drift apart.
const PLAYGROUND_PROTOCOL_UNSUPPORTED_FIELDS: Record<
  PlaygroundProtocol,
  ReadonlyArray<keyof ChatCompletionRequest>
> = {
  chat: [],
  responses: ['frequency_penalty', 'presence_penalty', 'seed'],
  messages: [
    'frequency_penalty',
    'presence_penalty',
    'seed',
    'reasoning_effort',
    'response_format',
  ],
}

/**
 * Converts the assembled chat payload into the selected protocol's wire body.
 * Chat returns the payload unchanged. The conversion keeps every field the
 * target protocol supports and drops the ones it does not, so the request
 * never carries a silently ignored parameter; a field the relay rejects
 * surfaces as an ordinary relay error.
 */
export function buildPlaygroundProtocolRequest(
  payload: ChatCompletionRequest,
  protocol: PlaygroundProtocol
): PlaygroundProtocolRequest {
  if (protocol === 'chat') {
    return {
      protocol,
      endpoint: API_ENDPOINTS.CHAT_COMPLETIONS,
      body: payload as unknown as Record<string, unknown>,
    }
  }

  if (protocol === 'responses') {
    const body: PlaygroundResponsesRequest = {
      model: payload.model,
      input: responsesInputItems(conversationMessages(payload.messages)),
      stream: payload.stream,
    }
    const instructions = systemInstruction(payload.messages)
    if (instructions !== '') body.instructions = instructions
    if (payload.max_tokens !== undefined) {
      body.max_output_tokens = payload.max_tokens
    }
    if (payload.temperature !== undefined)
      body.temperature = payload.temperature
    if (payload.top_p !== undefined) body.top_p = payload.top_p
    if (payload.reasoning_effort) {
      body.reasoning = { effort: payload.reasoning_effort }
    }
    if (payload.tools) body.tools = responsesTools(payload.tools)
    if (payload.tool_choice) body.tool_choice = payload.tool_choice
    if (payload.response_format) body.text = { format: payload.response_format }
    if (payload.group !== undefined) body.group = payload.group
    return {
      protocol,
      endpoint: API_ENDPOINTS.RESPONSES,
      body: body as unknown as Record<string, unknown>,
    }
  }

  const body: PlaygroundMessagesRequest = {
    model: payload.model,
    // Anthropic requires max_tokens, so an unset parameter falls back to the
    // composer default instead of leaving the field out.
    max_tokens: payload.max_tokens ?? PLAYGROUND_MESSAGES_FALLBACK_MAX_TOKENS,
    messages: messagesWireMessages(conversationMessages(payload.messages)),
    stream: payload.stream,
  }
  const system = systemInstruction(payload.messages)
  if (system !== '') body.system = system
  if (payload.temperature !== undefined) body.temperature = payload.temperature
  if (payload.top_p !== undefined) body.top_p = payload.top_p
  if (payload.tools) {
    body.tools = payload.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }))
  }
  const toolChoice = messagesToolChoice(payload.tool_choice)
  if (toolChoice) body.tool_choice = toolChoice
  if (payload.group !== undefined) body.group = payload.group
  return {
    protocol,
    endpoint: API_ENDPOINTS.MESSAGES,
    body: body as unknown as Record<string, unknown>,
  }
}

/**
 * Names of the assembled payload fields the selected protocol drops. The
 * composer and the request viewer report them, so a parameter the target
 * protocol does not accept is visible before and after the send instead of
 * silently missing from the wire body.
 */
export function playgroundProtocolUnsupportedFields(
  payload: ChatCompletionRequest,
  protocol: PlaygroundProtocol
): string[] {
  return PLAYGROUND_PROTOCOL_UNSUPPORTED_FIELDS[protocol].filter(
    (field) => payload[field] !== undefined
  )
}
