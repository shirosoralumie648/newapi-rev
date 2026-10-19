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
import type { RequestTimingBreakdown } from '@/features/usage-logs/types'

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
  /**
   * Model that produced this version. Parallel comparison labels every
   * compared reply with the model it came from; ordinary versions leave it
   * absent.
   */
  model?: string
  /**
   * Lifecycle of one version of a parallel comparison: `loading` while its
   * request runs, `error` when it failed. Absent means the version states
   * nothing beyond the message itself.
   */
  status?: MessageStatus
  /** Stable server error code of a failed parallel version, when any. */
  errorCode?: string | null
  attachments?: MessageAttachment[]
  /**
   * Cached read-aloud audio of this version, stored as an owned conversation
   * attachment. Only the reference belongs to the message; the bytes stay in
   * the attachment store and survive because the snapshot references them.
   */
  speech?: MessageAttachment
  toolCalls?: MessageToolCall[]
  /**
   * Relay request id of the generation that produced this version. It only
   * associates the version with the owner's consume log; the log stays the
   * single source of the billed amount.
   */
  requestId?: string
  /** Token usage the relay reported when this version finished generating. */
  usage?: MessageUsage
  /**
   * Why the generation of this version ended, as the provider reported it
   * (`length` when the output hit the token cap, `interrupted` when the user
   * stopped it). The value only labels the stored version so a truncated reply
   * can offer "continue generation"; it never feeds billing.
   */
  finishReason?: string
}

/**
 * Token usage of one generated version. Kept beside the message so the
 * workspace can label a reply without another upstream call; billing figures
 * are always read from the settle log.
 */
export interface MessageUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * The settled consume-log row of one relay request, read back through the
 * read-only Playground cost lookup. All figures are display-only.
 */
export interface PlaygroundMessageCost {
  requestId: string
  quota: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  modelName: string
  createdAt: number
  /** Server-side phase breakdown of the request, when the entry recorded one. */
  timing?: RequestTimingBreakdown
}

/**
 * One normalized web-search hit of a turn. The server already bounded every
 * field; the browser only stores and renders it.
 */
export interface MessageSearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Web-search snapshot of one user turn: the query that was searched and the
 * normalized hits injected into the request. It is the source of truth for
 * replay, so the same turn always carries the same context, and the assistant
 * reply copies the hits into `sources` for citation rendering.
 */
export interface MessageSearchSnapshot {
  query: string
  provider?: string
  results: MessageSearchResult[]
}

export interface Message {
  key: string
  from: MessageRole
  versions: MessageVersion[]
  /**
   * Assistant message group produced by one parallel comparison: every
   * version holds the reply of the model it names, and the selected version
   * continues the conversation. Messages from ordinary sends leave it unset.
   */
  parallel?: boolean
  /** Index of the active version in `versions`; defaults to 0 for legacy data. */
  activeVersionIndex?: number
  createdAt?: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
  sources?: { href: string; title: string }[]
  search?: MessageSearchSnapshot
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

/**
 * Context management settings of one conversation. `historyLimit` is the
 * number of stored messages a request may carry and `tokenBudget` the
 * estimated token budget of the request; 0 disables the respective limit.
 * `autoSummarize` summarizes the messages a limit leaves out through /pg
 * before sending, and `summaryModel` picks the model (empty = the
 * conversation model). Compression only changes what is sent; stored
 * messages are never deleted.
 */
export interface PlaygroundContextSettings {
  historyLimit: number
  tokenBudget: number
  autoSummarize: boolean
  summaryModel: string
}

/**
 * The persisted compression node of a conversation: the summary that replaces
 * every message up to and including `throughMessageKey` in requests. The
 * content was produced by an ordinary billed /pg call; `requestId`/`usage`
 * only label that call. A summary the messages no longer match is ignored and
 * can be removed, which restores sending the full history.
 */
export interface PlaygroundContextSummary {
  id: string
  content: string
  throughMessageKey: string
  messageCount: number
  model: string
  createdAt: number
  requestId?: string
  usage?: MessageUsage
}

/**
 * A partial organization change for one conversation. An omitted switch keeps
 * its stored value; `tags` replaces the complete list when present.
 */
export interface PlaygroundSessionOrganization {
  pinned?: boolean
  archived?: boolean
  tags?: string[]
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
  /**
   * Display-only greeting from the preset that started this conversation. It is
   * shown on the empty state and never sent to the model.
   */
  openingMessage: string
  /** Starter questions shown on the empty state; never sent to the model. */
  suggestedQuestions: string[]
  /** Context limits, auto-summary flag and summary model of the conversation. */
  context: PlaygroundContextSettings
  /** Persisted compression node, or null when the full history is sent. */
  contextSummary: PlaygroundContextSummary | null
  /** Conversation stays in the pinned section of the client-side list. */
  pinned: boolean
  /** Archived conversations collapse into their own client-side section. */
  archived: boolean
  /** Client-side labels stored as a bounded JSON array on the server. */
  tags: string[]
  messages: Message[]
  server?: { id: string; revision: number; messageRevision: number }
  syncPending?: boolean
}

export type PlaygroundPresetVisibility = 'private' | 'global'

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
  /** Private presets belong to one account; global presets come from the market. */
  visibility: PlaygroundPresetVisibility
  /** Display-only greeting copied into a new conversation. */
  openingMessage: string
  /** Starter questions copied into a new conversation and shown before its first message. */
  suggestedQuestions: string[]
  createdAt: number
  updatedAt: number
}

/**
 * A reusable prompt fragment owned by the account: a short display name and the
 * text the composer inserts. Snippets never carry credentials or provider
 * addresses; inserting one only fills the composer.
 */
export interface PromptSnippet {
  id: string
  name: string
  content: string
  createdAt: number
  updatedAt: number
}

/**
 * A durable cross-session note owned by the account. Memories are derived from
 * the owner's own conversations (or written by hand), optionally point back at
 * the source conversation, and are injected as one system message into the
 * next request only while enabled.
 */
export interface PlaygroundMemory {
  id: string
  content: string
  category: string
  sourceSessionId: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Browser-owned extraction preference of one account. It is off by default so
 * no conversation is sent to the extraction model until the owner opts in;
 * the model is empty while the setting follows the context summary model.
 */
export interface PlaygroundMemoryExtractionSettings {
  enabled: boolean
  model: string
}

/**
 * Composer-level quote of an earlier message: the key the quote points at plus
 * the text snapshot shown in the quote bar. The stored message contract has no
 * quote field, so the snapshot travels with the next request only and is
 * discarded once that send starts.
 */
export interface PlaygroundPendingQuote {
  messageKey: string
  text: string
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

/** File format of a conversation export rendered by the host. */
export type PlaygroundExportFormat = 'markdown' | 'json'

/** One conversation export file: body, media type and suggested filename. */
export interface PlaygroundSessionExport {
  format: PlaygroundExportFormat
  filename: string
  contentType: string
  content: string
}

/** One preset export file: the JSON import document and its download metadata. */
export interface PlaygroundPresetExport {
  format: 'json'
  filename: string
  contentType: string
  content: string
}

/** The kind of resource a trash entry points to. */
export type PlaygroundTrashItemKind = 'session' | 'canvas'

/** One trashed conversation or canvas with its purge deadline. */
export interface PlaygroundTrashItem {
  kind: PlaygroundTrashItemKind
  id: string
  title: string
  /** When the entry moved to the trash, in epoch milliseconds. */
  deletedAt: number
  /** The earliest time the retention sweep may purge it, epoch milliseconds. */
  purgeAt: number
}

/** The account's trash: entries plus the owner's retention window. */
export interface PlaygroundTrashListing {
  /** Days a trash entry stays recoverable before the sweep may purge it. */
  retentionDays: number
  items: PlaygroundTrashItem[]
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
  /**
   * Reasoning strength for the models that support it. The value is one of the
   * effort strings the relay accepts (`none`, `minimal`, `low`, `medium`,
   * `high`, `xhigh`, `max`) or empty while the parameter stays unset.
   */
  reasoning_effort?: string
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
  /** Final usage frame; new-api appends it by default when upstream omits it. */
  usage?: ChatCompletionUsage
}

/** Wire shape of the usage object shared by streamed and complete responses. */
export interface ChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
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
  usage?: ChatCompletionUsage
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
  /**
   * Reasoning effort of the conversation; empty means unset. Only the values
   * the relay accepts are storable, and the control is offered solely for the
   * model families known to support it.
   */
  reasoning_effort: string
  stream: boolean
}

export interface ParameterEnabled {
  temperature: boolean
  top_p: boolean
  max_tokens: boolean
  frequency_penalty: boolean
  presence_penalty: boolean
  seed: boolean
  reasoning_effort: boolean
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
