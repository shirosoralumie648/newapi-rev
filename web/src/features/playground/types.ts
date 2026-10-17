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
// Message types
export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus = 'loading' | 'streaming' | 'complete' | 'error'

export type PlaygroundMessageLayoutMode = 'alternating' | 'left'

export interface MessageAttachment {
  id: string
  url: string
  mediaType: string
  filename?: string
  byteSize?: number
}

/**
 * Tool calls are never executed by the Playground. A pending call waits for the
 * user to paste the result obtained elsewhere (or to deny the call), and the
 * answer is only relayed to the model as a `tool` message.
 */
export type MessageToolCallStatus = 'pending' | 'completed' | 'denied' | 'error'

export interface MessageToolCall {
  id: string
  name: string
  /** Raw JSON arguments requested by the model; kept as text, never evaluated. */
  arguments: string
  status: MessageToolCallStatus
  /** Result the user provided manually. */
  result?: string
  errorMessage?: string
  createdAt?: number
  completedAt?: number
}

export interface MessageVersion {
  id: string
  content: string
  attachments?: MessageAttachment[]
  toolCalls?: MessageToolCall[]
}

export interface Message {
  key: string
  from: MessageRole
  versions: MessageVersion[]
  /** Index of the active version in `versions`; defaults to 0 for legacy data. */
  activeVersionIndex?: number
  createdAt?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  sources?: { href: string; title: string }[]
  reasoning?: {
    content: string
    duration: number
    startedAt?: number
    completedAt?: number
    durationMs?: number
  }
  isReasoningStreaming?: boolean
  isReasoningComplete?: boolean
  isContentComplete?: boolean
  status?: MessageStatus
  errorCode?: string | null
}

export interface PlaygroundSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  /** Conversation-level instruction injected as the first `system` message. */
  systemPrompt: string
  messages: Message[]
  server?: { id: string; revision: number; messageRevision: number }
  syncPending?: boolean
}

/**
 * A reusable assistant definition owned by the account: a name and avatar, the
 * model and sampling parameters it applies, and a system prompt. Applying one
 * copies these fields into a conversation; presets never carry credentials or
 * provider addresses.
 */
export interface AssistantPreset {
  id: string
  name: string
  avatar: string
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

/**
 * Deep-link target for the Playground route. `session` is the canonical server
 * session id a canvas node points back to; `artifact` selects a saved artifact
 * inside that session.
 */
export interface PlaygroundRouteTarget {
  session?: string
  message?: string
  artifact?: string
}

export interface PlaygroundSessionsState {
  activeSessionId: string
  sessions: PlaygroundSession[]
}

export interface PlaygroundServerSession extends Omit<
  PlaygroundSession,
  'messages'
> {
  clientId?: string
  revision: number
  messageRevision: number
}

// API payload types
export type PlaygroundInputAttachment = MessageAttachment

export interface PlaygroundInputMessage {
  text?: string
  files?: PlaygroundInputAttachment[]
}

export interface ChatCompletionMessage {
  role: MessageRole | 'tool'
  content: string | ContentPart[]
  tool_calls?: ChatCompletionToolCall[]
  tool_call_id?: string
}

export interface ChatCompletionToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
  }
}

export interface ChatCompletionRequest {
  model: string
  group?: string
  messages: ChatCompletionMessage[]
  stream: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: MessageRole
      content?: string
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: ChatCompletionToolCallDelta[]
    }
    finish_reason: string | null
  }>
}

/**
 * A streamed tool call fragment. Later chunks repeat the same `index` and only
 * carry the missing part of `arguments` (and occasionally of `id`/`name`).
 */
export interface ChatCompletionToolCallDelta {
  index: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: MessageRole
      content: string
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: ChatCompletionToolCall[]
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// Configuration types
export interface PlaygroundConfig {
  model: string
  group: string
  temperature: number
  top_p: number
  max_tokens: number
  frequency_penalty: number
  presence_penalty: number
  seed: number | null
  stream: boolean
}

export interface ParameterEnabled {
  temperature: boolean
  top_p: boolean
  max_tokens: boolean
  frequency_penalty: boolean
  presence_penalty: boolean
  seed: boolean
}

// Model and group options
export interface ModelOption {
  label: string
  value: string
}

export interface GroupOption {
  label: string
  value: string
  ratio: number | string
  desc?: string
}

// Media generation the workspace can start through the /pg relay routes.
export type PlaygroundGenerationKind = 'image' | 'video' | 'audio'
