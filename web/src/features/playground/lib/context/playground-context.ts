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
  DEFAULT_CONTEXT_SETTINGS,
  MESSAGE_ROLES,
  PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX,
  PLAYGROUND_CONTEXT_IMAGE_TOKEN_ESTIMATE,
  PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX,
  PLAYGROUND_SUMMARY_CONTEXT_PREFIX,
  PLAYGROUND_SUMMARY_INPUT_MAX_CHARS,
  PLAYGROUND_SUMMARY_SYSTEM_PROMPT,
  TOOL_CALL_STATUS,
} from '../../constants'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  Message,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../../types'
import { playgroundDocumentContextText } from '../document-context'
import {
  applyModelMediaPolicy,
  modelAcceptsImageInput,
  omitInlineBase64Media,
} from '../message/message-media-utils'
import {
  getMessageToolCalls,
  getToolCallResponseContent,
} from '../message/message-tool-call-utils'
import {
  normalizeMessageRequestId,
  toMessageUsage,
} from '../message/message-usage-utils'
import {
  formatMessageForAPI,
  formatMessageSearchContext,
  getCurrentVersion,
  isValidMessage,
} from '../message/message-utils'

/**
 * What one send would carry after context management, plus the bookkeeping a
 * caller needs to explain it: which stored messages are included, which are
 * replaced by the compression node and which a limit leaves out. Truncation
 * only affects the request; stored messages are never deleted.
 */
export interface PlaygroundContextPlan {
  /** Request-formatted messages, compression node first when one is used. */
  requestMessages: ChatCompletionMessage[]
  /** Stored messages whose text goes to the model. */
  includedMessages: Message[]
  /** Stored messages replaced by the compression node. */
  compressedMessages: Message[]
  /** Stored messages a configured limit leaves out of the request. */
  droppedMessages: Message[]
  /** Estimated tokens of the send, including the system prompt. */
  estimatedTokens: number
  /** Estimated tokens of the messages a limit leaves out. */
  droppedTokens: number
  /** Images replaced by placeholder text in the request. */
  omittedImages: number
  /** The summary this plan substitutes, or null when none applies. */
  summaryUsed: PlaygroundContextSummary | null
  /** Whether a history limit or token budget is configured. */
  hasLimits: boolean
  /** Whether the send differs from the stored history. */
  exceedsLimits: boolean
  /** Whether dropping messages needs a summary the node does not cover. */
  needsSummary: boolean
}

/**
 * One stored message can become several request messages: an assistant reply
 * that requested tool calls is followed by one `tool` message per answered
 * call. Pending calls stay out until the user answers or denies them.
 */
export function formatMessageForRequest(
  message: Message
): ChatCompletionMessage[] {
  const documentContext = playgroundDocumentContextText(
    getCurrentVersion(message).attachments ?? []
  )
  const searchContext = message.search
    ? formatMessageSearchContext(message.search)
    : ''
  const formatted = formatMessageForAPI(message, documentContext, searchContext)
  if (message.from !== MESSAGE_ROLES.ASSISTANT) {
    return [formatted]
  }

  const answeredCalls = getMessageToolCalls(message).filter(
    (call) => call.status !== TOOL_CALL_STATUS.PENDING
  )
  if (answeredCalls.length === 0) {
    return [formatted]
  }

  return [
    {
      ...formatted,
      tool_calls: answeredCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    },
    ...answeredCalls.map((call) => ({
      role: 'tool' as const,
      content: getToolCallResponseContent(call),
      tool_call_id: call.id,
    })),
  ]
}

/**
 * Cheap deterministic token estimate. ASCII runs at ~4 characters per token,
 * every non-ASCII code point counts as one token (a conservative fit for CJK
 * text). The figure is display and planning only; the relay's own accounting
 * stays authoritative for billing.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let nonAscii = 0
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 128) {
      ascii += 1
    } else {
      nonAscii += 1
    }
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function countMessageImages(message: Message): number {
  return (getCurrentVersion(message).attachments ?? []).filter((attachment) =>
    attachment.mediaType.startsWith('image/')
  ).length
}

/**
 * Estimated tokens of one stored message: its active version text and tool
 * call arguments, plus a fixed allowance per image attachment. Inline base64
 * media is measured after scrubbing, because the placeholder is what the
 * model actually receives. The data URL length is irrelevant for planning
 * because vision pricing is per image, not per encoded byte.
 */
export function estimateMessageTokens(message: Message): number {
  const version = getCurrentVersion(message)
  let tokens = estimateTextTokens(omitInlineBase64Media(version.content).text)
  tokens +=
    countMessageImages(message) * PLAYGROUND_CONTEXT_IMAGE_TOKEN_ESTIMATE
  if (message.search) {
    tokens += estimateTextTokens(formatMessageSearchContext(message.search))
  }
  for (const call of version.toolCalls ?? []) {
    tokens += estimateTextTokens(call.arguments)
  }
  return tokens
}

function boundInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const integer = Math.trunc(value)
  if (integer <= 0) return 0
  return Math.min(integer, max)
}

/**
 * Normalize stored or server-sent context settings into the local shape. A
 * value outside the server-validated range falls back to the closest
 * supported bound instead of reaching the request builder.
 */
export function normalizeContextSettings(
  value: unknown
): PlaygroundContextSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_CONTEXT_SETTINGS }
  }
  const source = value as Partial<PlaygroundContextSettings>
  return {
    historyLimit: boundInteger(
      source.historyLimit,
      PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX
    ),
    tokenBudget: boundInteger(
      source.tokenBudget,
      PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX
    ),
    autoSummarize: source.autoSummarize === true,
    summaryModel:
      typeof source.summaryModel === 'string'
        ? source.summaryModel.slice(0, 512)
        : '',
  }
}

/**
 * Normalize a stored or server-sent compression node. An incomplete node
 * (missing identity, content or coverage marker) yields null, so a corrupt
 * record degrades to sending the full history instead of an unusable state.
 */
export function normalizeContextSummary(
  value: unknown
): PlaygroundContextSummary | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PlaygroundContextSummary>
  const id = typeof source.id === 'string' ? source.id : ''
  const content = typeof source.content === 'string' ? source.content : ''
  const throughMessageKey =
    typeof source.throughMessageKey === 'string' ? source.throughMessageKey : ''
  if (!id || !content.trim() || !throughMessageKey) return null
  const requestId = normalizeMessageRequestId(source.requestId)
  const usage = source.usage
    ? toMessageUsage({
        prompt_tokens: source.usage.promptTokens,
        completion_tokens: source.usage.completionTokens,
        total_tokens: source.usage.totalTokens,
      })
    : undefined
  return {
    id,
    content,
    throughMessageKey,
    messageCount: boundInteger(source.messageCount, 1_000_000),
    model: typeof source.model === 'string' ? source.model.slice(0, 512) : '',
    createdAt:
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
        ? source.createdAt
        : 0,
    ...(requestId ? { requestId } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** The `system` message that carries the compression node into a request. */
export function formatContextSummaryMessage(
  summary: PlaygroundContextSummary
): ChatCompletionMessage {
  return {
    role: 'system',
    content: `${PLAYGROUND_SUMMARY_CONTEXT_PREFIX}\n${summary.content}`,
  }
}

/**
 * The context one send would use. The compression node replaces the stored
 * messages up to its coverage marker; the remaining messages are trimmed to
 * the newest `historyLimit` messages and to the token budget (the newest
 * message is always kept, even when it alone exceeds the budget). A summary
 * whose coverage marker no longer exists in the conversation is ignored so a
 * deleted message cannot make the request unsendable.
 */
export function planPlaygroundContext(options: {
  messages: Message[]
  settings: PlaygroundContextSettings
  summary?: PlaygroundContextSummary | null
  systemPrompt?: string
  /** Enabled cross-session memories, injected as an extra system message. */
  memoryBlock?: string
  /** Target model; omitted means unknown, which keeps structured images. */
  model?: string
}): PlaygroundContextPlan {
  const settings = normalizeContextSettings(options.settings)
  const validMessages = options.messages.filter(isValidMessage)
  // The injected instruction messages are part of the request estimate even
  // though they are not stored messages, so the token budget must reserve room
  // for the system prompt and the memory block before keeping history.
  const systemTokens =
    (options.systemPrompt
      ? estimateTextTokens(omitInlineBase64Media(options.systemPrompt).text)
      : 0) +
    (options.memoryBlock
      ? estimateTextTokens(omitInlineBase64Media(options.memoryBlock).text)
      : 0)

  let summaryUsed: PlaygroundContextSummary | null = null
  let compressedCount = 0
  if (options.summary && options.summary.content.trim() !== '') {
    const cutoff = validMessages.findIndex(
      (message) => message.key === options.summary?.throughMessageKey
    )
    if (cutoff >= 0) {
      summaryUsed = options.summary
      compressedCount = cutoff + 1
    }
  }
  const compressedMessages = validMessages.slice(0, compressedCount)
  const rest = validMessages.slice(compressedCount)

  let included = rest
  let dropped: Message[] = []
  if (settings.historyLimit > 0 && rest.length > settings.historyLimit) {
    included = rest.slice(rest.length - settings.historyLimit)
    dropped = rest.slice(0, rest.length - settings.historyLimit)
  }

  // A text-only model cannot receive structured images. Images from the newest
  // user turn stay: the user just attached them for this send, so dropping them
  // silently would be worse than the upstream error. Earlier images become a
  // placeholder, and their fixed allowance leaves the estimate as well (the
  // placeholder itself is only a few tokens).
  const acceptsImages = modelAcceptsImageInput(options.model ?? '')
  let newestUserIndex = -1
  for (let index = included.length - 1; index >= 0; index--) {
    if (included[index].from === MESSAGE_ROLES.USER) {
      newestUserIndex = index
      break
    }
  }
  const imageKeepingKeys = new Set(
    newestUserIndex >= 0
      ? included.slice(newestUserIndex).map((message) => message.key)
      : []
  )
  const estimateRequestMessageTokens = (message: Message): number => {
    let tokens = estimateMessageTokens(message)
    if (!acceptsImages && !imageKeepingKeys.has(message.key)) {
      tokens = Math.max(
        0,
        tokens -
          countMessageImages(message) * PLAYGROUND_CONTEXT_IMAGE_TOKEN_ESTIMATE
      )
    }
    return tokens
  }
  const summaryTokens = summaryUsed
    ? estimateTextTokens(omitInlineBase64Media(summaryUsed.content).text)
    : 0

  if (settings.tokenBudget > 0) {
    const baseTokens = systemTokens + summaryTokens
    const kept: Message[] = []
    let tokens = baseTokens
    for (let index = included.length - 1; index >= 0; index--) {
      const cost = estimateRequestMessageTokens(included[index])
      if (kept.length > 0 && tokens + cost > settings.tokenBudget) break
      kept.unshift(included[index])
      tokens += cost
    }
    if (kept.length < included.length) {
      dropped = [
        ...dropped,
        ...included.slice(0, included.length - kept.length),
      ]
      included = kept
    }
  }

  let estimatedTokens = systemTokens + summaryTokens
  for (const message of included) {
    estimatedTokens += estimateRequestMessageTokens(message)
  }

  let droppedTokens = 0
  for (const message of dropped) {
    droppedTokens += estimateMessageTokens(message)
  }

  const mediaPolicy = applyModelMediaPolicy(
    [
      ...(summaryUsed ? [formatContextSummaryMessage(summaryUsed)] : []),
      ...included.flatMap(formatMessageForRequest),
    ],
    options.model ?? ''
  )

  return {
    requestMessages: mediaPolicy.messages,
    includedMessages: included,
    compressedMessages,
    droppedMessages: dropped,
    estimatedTokens,
    droppedTokens,
    omittedImages: mediaPolicy.omittedImages,
    summaryUsed,
    hasLimits: settings.historyLimit > 0 || settings.tokenBudget > 0,
    exceedsLimits: compressedMessages.length > 0 || dropped.length > 0,
    needsSummary: dropped.length > 0,
  }
}

// One message of the summarization input. Images are left out: the summary
// only needs the text, and re-uploading vision content would multiply the
// cost of a call the user pays for.
function formatMessageForSummary(
  message: Message
): ChatCompletionMessage | null {
  const version = getCurrentVersion(message)
  const parts: string[] = []
  const text = omitInlineBase64Media(version.content).text
  if (text.trim()) {
    parts.push(text)
  }
  const callNames = (version.toolCalls ?? [])
    .map((call) => call.name)
    .filter((name) => name.trim() !== '')
  if (callNames.length > 0) {
    parts.push(`[requested tool calls: ${callNames.join(', ')}]`)
  }
  const content = parts.join('\n').trim()
  if (!content) return null
  return { role: message.from, content }
}

// The summarization input keeps the newest messages whole and clips the oldest
// one that crosses the bound, so the call stays inside a predictable size
// while the recent context — what a summary needs most — is never cut away.
function collectSummaryInputMessages(
  messages: Message[]
): ChatCompletionMessage[] {
  const collected: ChatCompletionMessage[] = []
  let remaining = PLAYGROUND_SUMMARY_INPUT_MAX_CHARS
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const formatted = formatMessageForSummary(messages[index])
    if (!formatted || typeof formatted.content !== 'string') continue
    const content =
      formatted.content.length > remaining
        ? formatted.content.slice(formatted.content.length - remaining)
        : formatted.content
    remaining -= content.length
    collected.unshift({ ...formatted, content })
  }
  return collected
}

/**
 * The non-streaming request that compresses the messages a limit leaves out.
 * It is an ordinary `/pg/chat/completions` call, so it is billed, grouped and
 * attributed exactly like a normal conversation turn. An existing summary is
 * passed as context so the new node covers its content too.
 */
export function buildContextSummaryRequest(options: {
  messages: Message[]
  previousSummary?: PlaygroundContextSummary | null
  model: string
  group: string
}): ChatCompletionRequest {
  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: PLAYGROUND_SUMMARY_SYSTEM_PROMPT },
  ]
  if (options.previousSummary?.content.trim()) {
    messages.push({
      role: 'system',
      content: `${PLAYGROUND_SUMMARY_CONTEXT_PREFIX}\n${options.previousSummary.content}`,
    })
  }
  messages.push(...collectSummaryInputMessages(options.messages))
  return {
    model: options.model,
    group: options.group,
    messages,
    stream: false,
  }
}
