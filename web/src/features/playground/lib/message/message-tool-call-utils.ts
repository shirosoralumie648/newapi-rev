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
  MESSAGE_ROLES,
  MESSAGE_STATUS,
  TOOL_CALL_DENIED_CONTENT,
  TOOL_CALL_FAILED_CONTENT,
  TOOL_CALL_STATUS,
} from '../../constants'
import type {
  ChatCompletionToolCall,
  ChatCompletionToolCallDelta,
  Message,
  MessageToolCall,
  MessageToolCallStatus,
  MessageVersion,
} from '../../types'
import { getActiveVersionIndex } from './message-utils'

/**
 * Tool call state helpers. Playground stores both the call the model requested
 * and the result that answered it — either produced by the automatic executor
 * or provided manually by the user; the server never executes a tool.
 */
export function getVersionToolCalls(
  version: MessageVersion | undefined
): MessageToolCall[] {
  return version?.toolCalls ?? []
}

export function getMessageToolCalls(message: Message): MessageToolCall[] {
  return getVersionToolCalls(message.versions[getActiveVersionIndex(message)])
}

export function getPendingToolCalls(message: Message): MessageToolCall[] {
  return getMessageToolCalls(message).filter(
    (call) => call.status === TOOL_CALL_STATUS.PENDING
  )
}

// A pending call only blocks the next request while it belongs to the latest
// assistant reply; older calls were either answered or abandoned.
export function hasPendingToolCalls(messages: Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.from !== MESSAGE_ROLES.ASSISTANT) continue
    return getPendingToolCalls(message).length > 0
  }
  return false
}

export function canContinueToolCalls(message: Message): boolean {
  if (message.from !== MESSAGE_ROLES.ASSISTANT) return false
  if (getMessageToolCalls(message).length === 0) return false
  if (getPendingToolCalls(message).length > 0) return false
  return (
    message.status !== MESSAGE_STATUS.LOADING &&
    message.status !== MESSAGE_STATUS.STREAMING
  )
}

/**
 * Append a streamed fragment, tolerating providers that resend the value
 * accumulated so far instead of only the missing part.
 */
function appendStreamedFragment(current: string, next?: string): string {
  if (!next) return current
  if (!current || !next.startsWith(current)) return current + next
  return current + next.slice(current.length)
}

export type ToolCallDelta = ChatCompletionToolCallDelta

export function applyToolCallDelta(
  message: Message,
  delta: ToolCallDelta
): Message {
  if (message.status === MESSAGE_STATUS.ERROR) return message

  const activeIndex = getActiveVersionIndex(message)
  const toolCalls = getVersionToolCalls(message.versions[activeIndex])
  // Providers stream calls in index order starting at 0. Rejecting gaps keeps
  // the stored array dense, so a partial stream can never persist a sparse
  // snapshot that fails validation on the next save.
  if (
    !Number.isInteger(delta.index) ||
    delta.index < 0 ||
    delta.index > toolCalls.length
  ) {
    return message
  }

  return {
    ...message,
    versions: message.versions.map((version, index) => {
      if (index !== activeIndex) return version
      const calls = [...getVersionToolCalls(version)]
      const current: MessageToolCall = calls[delta.index] ?? {
        id: '',
        name: '',
        arguments: '',
        status: TOOL_CALL_STATUS.PENDING,
        createdAt: Date.now(),
      }
      calls[delta.index] = {
        ...current,
        id: appendStreamedFragment(current.id, delta.id),
        name: appendStreamedFragment(current.name, delta.function?.name),
        arguments: appendStreamedFragment(
          current.arguments,
          delta.function?.arguments
        ),
      }
      return { ...version, toolCalls: calls }
    }),
    status: MESSAGE_STATUS.STREAMING,
  }
}

/**
 * Replace the active version's tool calls with a complete non-streaming
 * response. Later user-provided results are merged on top of these entries.
 */
export function applyResponseToolCalls(
  message: Message,
  toolCalls?: ChatCompletionToolCall[]
): Message {
  if (!toolCalls || toolCalls.length === 0) return message

  const activeIndex = getActiveVersionIndex(message)
  const createdAt = Date.now()
  return {
    ...message,
    versions: message.versions.map((version, index) =>
      index === activeIndex
        ? {
            ...version,
            toolCalls: toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
              status: TOOL_CALL_STATUS.PENDING,
              createdAt,
            })),
          }
        : version
    ),
  }
}

function updateVersionToolCall(
  version: MessageVersion,
  toolCallId: string,
  status: MessageToolCallStatus,
  result: string | undefined,
  errorMessage: string | undefined
): MessageVersion {
  const completedAt = Date.now()
  return {
    ...version,
    toolCalls: getVersionToolCalls(version).map((call) =>
      call.id === toolCallId
        ? {
            ...call,
            status,
            result,
            errorMessage:
              status === TOOL_CALL_STATUS.ERROR ? errorMessage : undefined,
            completedAt,
          }
        : call
    ),
  }
}

export function setToolCallStatus(
  message: Message,
  toolCallId: string,
  status: MessageToolCallStatus,
  result?: string,
  errorMessage?: string
): Message {
  const activeIndex = getActiveVersionIndex(message)
  return {
    ...message,
    versions: message.versions.map((version, index) =>
      index === activeIndex
        ? updateVersionToolCall(
            version,
            toolCallId,
            status,
            result,
            errorMessage
          )
        : version
    ),
  }
}

/**
 * Update one tool call inside a specific message of the conversation.
 */
export function updateMessageToolCallStatus(
  messages: Message[],
  messageKey: string,
  toolCallId: string,
  status: MessageToolCallStatus,
  result?: string,
  errorMessage?: string
): Message[] {
  return messages.map((message) =>
    message.key === messageKey
      ? setToolCallStatus(message, toolCallId, status, result, errorMessage)
      : message
  )
}

/**
 * Update one tool call of an explicitly named version. Automatic execution
 * writes through this helper because the active version can change while a
 * request is in flight; the outcome still belongs to the version that
 * requested the call.
 */
export function updateVersionToolCallStatus(
  messages: Message[],
  messageKey: string,
  versionId: string,
  toolCallId: string,
  status: MessageToolCallStatus,
  result?: string,
  errorMessage?: string
): Message[] {
  return messages.map((message) => {
    if (message.key !== messageKey) return message
    // A message whose versions are all untouched keeps its identity so callers
    // can rely on reference equality to skip work.
    if (!message.versions.some((version) => version.id === versionId)) {
      return message
    }
    return {
      ...message,
      versions: message.versions.map((version) =>
        version.id === versionId
          ? updateVersionToolCall(
              version,
              toolCallId,
              status,
              result,
              errorMessage
            )
          : version
      ),
    }
  })
}

/**
 * Content of the `tool` message sent back to the model for an answered call.
 */
export function getToolCallResponseContent(call: MessageToolCall): string {
  if (call.result !== undefined) return call.result
  if (call.status === TOOL_CALL_STATUS.DENIED) return TOOL_CALL_DENIED_CONTENT
  if (call.status === TOOL_CALL_STATUS.ERROR) {
    return call.errorMessage ?? TOOL_CALL_FAILED_CONTENT
  }
  return ''
}
