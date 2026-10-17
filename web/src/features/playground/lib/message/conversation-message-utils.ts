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
import { MESSAGE_ROLES, MESSAGE_STATUS } from '../../constants'
import type { Message, MessageAttachment } from '../../types'
import {
  appendMessageVersion,
  createLoadingAssistantMessage,
  createUserMessage,
  getMessageContent,
} from './message-utils'

type ApplyMessageEditResult = {
  messages: Message[]
  shouldSend: boolean
}

type ChatMessageRenderState = {
  alwaysShowActions: boolean
  isEditing: boolean
}

// Append a fresh reply version and reset the message to a pending state. The
// previous answer stays selectable as a branch.
function startAssistantReply(
  message: Message,
  startedAt: number = Date.now()
): Message {
  return {
    ...appendMessageVersion(message, ''),
    startedAt,
    completedAt: undefined,
    durationMs: undefined,
    sources: undefined,
    reasoning: undefined,
    isReasoningStreaming: false,
    isReasoningComplete: false,
    isContentComplete: false,
    status: MESSAGE_STATUS.LOADING,
    errorCode: null,
  }
}

// The generated reply must stay the last message because streaming handlers
// target the final assistant message. Reuse the reply that follows the user
// message as a new version when present; otherwise append a loading reply.
function regenerateAssistantReply(
  messages: Message[],
  userMessageIndex: number,
  startedAt: number = Date.now()
): Message[] {
  const assistantIndex = userMessageIndex + 1
  const assistant = messages[assistantIndex]

  if (assistant?.from === MESSAGE_ROLES.ASSISTANT) {
    return [
      ...messages.slice(0, assistantIndex),
      startAssistantReply(assistant, startedAt),
    ]
  }

  return [
    ...messages.slice(0, userMessageIndex + 1),
    createLoadingAssistantMessage(startedAt),
  ]
}

export function appendUserMessagePair(
  messages: Message[],
  content: string,
  attachments?: MessageAttachment[]
): Message[] {
  const submittedAt = Date.now()

  return [
    ...messages,
    createUserMessage(content, submittedAt, attachments),
    createLoadingAssistantMessage(submittedAt),
  ]
}

export function createRegeneratedMessages(
  messages: Message[],
  messageKey: string
): Message[] | null {
  const messageIndex = messages.findIndex(
    (message) => message.key === messageKey
  )

  if (messageIndex === -1) {
    return null
  }

  if (messages[messageIndex].from === MESSAGE_ROLES.USER) {
    return regenerateAssistantReply(messages, messageIndex)
  }

  return [
    ...messages.slice(0, messageIndex),
    startAssistantReply(messages[messageIndex]),
  ]
}

export function removeMessageByKey(
  messages: Message[],
  messageKey: string
): Message[] {
  return messages.filter((message) => message.key !== messageKey)
}

export function getPreviousUserMessage(
  messages: Message[],
  beforeIndex: number
): Message | null {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    if (messages[index].from === MESSAGE_ROLES.USER) {
      return messages[index]
    }
  }

  return null
}

export function applyMessageEdit(
  messages: Message[],
  messageKey: string,
  content: string,
  shouldSubmit: boolean
): ApplyMessageEditResult | null {
  const submittedAt = Date.now()
  const messageIndex = messages.findIndex(
    (message) => message.key === messageKey
  )

  if (messageIndex === -1) {
    return null
  }

  const updatedMessages = messages.map((message) =>
    message.key === messageKey
      ? {
          ...appendMessageVersion(message, content),
          createdAt: shouldSubmit ? submittedAt : message.createdAt,
        }
      : message
  )

  if (
    !shouldSubmit ||
    updatedMessages[messageIndex].from !== MESSAGE_ROLES.USER
  ) {
    return { messages: updatedMessages, shouldSend: false }
  }

  return {
    messages: regenerateAssistantReply(
      updatedMessages,
      messageIndex,
      submittedAt
    ),
    shouldSend: true,
  }
}

export function getEditingMessageContent(
  messages: Message[],
  editingKey?: string | null
): string {
  if (!editingKey) {
    return ''
  }

  const message = messages.find((item) => item.key === editingKey)
  return message ? getMessageContent(message) : ''
}

export function getChatMessageRenderState(
  messages: Message[],
  message: Message,
  messageIndex: number,
  editingKey?: string | null
): ChatMessageRenderState {
  return {
    alwaysShowActions:
      messageIndex === messages.length - 1 &&
      message.from === MESSAGE_ROLES.ASSISTANT,
    isEditing: editingKey === message.key,
  }
}
