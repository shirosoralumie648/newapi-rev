import {
  CONTINUE_GENERATION_INSTRUCTION,
  MESSAGE_ROLES,
  MESSAGE_STATUS,
} from '../../constants'
import type {
  Message,
  MessageAttachment,
  MessageSearchSnapshot,
} from '../../types'
import { isMessageTruncated } from './message-continuation-utils'
import {
  appendMessageVersion,
  createLoadingAssistantMessage,
  createUserMessage,
  getActiveVersionIndex,
  getMessageContent,
  getMessageSearchSources,
  hasMessageContent,
  updateCurrentVersionContent,
} from './message-utils'
import { isParallelMessage } from './parallel-compare-utils'

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
  startedAt: number = Date.now(),
  sources?: Message['sources']
): Message {
  return {
    ...appendMessageVersion(message, ''),
    startedAt,
    completedAt: undefined,
    durationMs: undefined,
    sources: sources && sources.length > 0 ? sources : undefined,
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
// A comparison group cannot take one more version — its versions are labelled
// models — so editing and resubmitting replaces the group like any other
// regenerated reply instead of corrupting it with a streamed single answer.
function regenerateAssistantReply(
  messages: Message[],
  userMessageIndex: number,
  startedAt: number = Date.now(),
  sources?: Message['sources']
): Message[] {
  const assistantIndex = userMessageIndex + 1
  const assistant = messages[assistantIndex]

  if (
    assistant?.from === MESSAGE_ROLES.ASSISTANT &&
    !isParallelMessage(assistant)
  ) {
    return [
      ...messages.slice(0, assistantIndex),
      startAssistantReply(assistant, startedAt, sources),
    ]
  }

  return [
    ...messages.slice(0, userMessageIndex + 1),
    createLoadingAssistantMessage(startedAt, sources),
  ]
}

export function appendUserMessagePair(
  messages: Message[],
  content: string,
  attachments?: MessageAttachment[],
  search?: MessageSearchSnapshot
): Message[] {
  const submittedAt = Date.now()

  return [
    ...messages,
    createUserMessage(content, submittedAt, attachments, search),
    createLoadingAssistantMessage(submittedAt, getMessageSearchSources(search)),
  ]
}

/**
 * Continue the conversation after the user answered (or denied) the tool calls
 * requested by the latest assistant reply. No new user turn is added: the
 * answers travel as `tool` messages expanded from the assistant snapshot.
 */
export function createToolContinuationMessages(
  messages: Message[],
  startedAt: number = Date.now()
): Message[] {
  const last = messages.at(-1)
  return [...messages, createLoadingAssistantMessage(startedAt, last?.sources)]
}

/**
 * One continuation plan of a truncated reply: the state keeps the truncated
 * version as a branch and appends an empty version the stream fills, while the
 * request carries the truncated reply as the last assistant turn (assistant
 * prefill semantics). `fallbackMessages` appends one user instruction for
 * channels that reject an assistant prefill.
 */
export interface PlaygroundContinuationPlan {
  stateMessages: Message[]
  prefillMessages: Message[]
  fallbackMessages: Message[]
  /** The truncated text the continuation branch starts from. */
  prefix: string
}

/**
 * Continue a truncated assistant reply. Only the last message can continue:
 * the reply must be an assistant message that was cut short, and the
 * continuation itself is appended as a new version so the truncated text is
 * never lost.
 */
export function createContinuationMessages(
  messages: Message[],
  messageKey: string
): PlaygroundContinuationPlan | null {
  const last = messages.at(-1)
  if (
    !last ||
    last.key !== messageKey ||
    last.from !== MESSAGE_ROLES.ASSISTANT ||
    last.status === MESSAGE_STATUS.LOADING ||
    last.status === MESSAGE_STATUS.STREAMING ||
    !hasMessageContent(last) ||
    !isMessageTruncated(last)
  ) {
    return null
  }

  // The new branch starts with the truncated text and the stream appends the
  // continuation to it, so switching branches shows the complete answer while
  // the truncated version stays available untouched.
  const prefix = getMessageContent(last)
  return {
    stateMessages: [
      ...messages.slice(0, -1),
      updateCurrentVersionContent(
        startAssistantReply(last, Date.now(), last.sources),
        prefix
      ),
    ],
    prefillMessages: messages,
    fallbackMessages: [
      ...messages,
      createUserMessage(CONTINUE_GENERATION_INSTRUCTION),
    ],
    prefix,
  }
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
    return regenerateAssistantReply(
      messages,
      messageIndex,
      Date.now(),
      getMessageSearchSources(messages[messageIndex].search)
    )
  }

  // Regenerating a reply keeps its citations: they belong to the searched user
  // turn, not to the version the provider is about to replace.
  return [
    ...messages.slice(0, messageIndex),
    startAssistantReply(
      messages[messageIndex],
      Date.now(),
      messages[messageIndex].sources
    ),
  ]
}

/**
 * Retry a failed reply after removing the images that the model rejected. Only
 * the active version of the user turn is changed; document attachments stay,
 * and the original version remains available as a branch. Returns null when
 * there is no image to remove or the turn would become empty.
 */
export function createRegeneratedMessagesWithoutImages(
  messages: Message[],
  messageKey: string
): Message[] | null {
  const messageIndex = messages.findIndex(
    (message) => message.key === messageKey
  )
  if (messageIndex === -1) return null

  const userMessage = getPreviousUserMessage(messages, messageIndex)
  if (!userMessage) return null

  const activeIndex = getActiveVersionIndex(userMessage)
  const activeVersion = userMessage.versions[activeIndex]
  if (!activeVersion) return null

  const attachments = activeVersion.attachments ?? []
  const remainingAttachments = attachments.filter(
    (attachment) => !attachment.mediaType.toLowerCase().startsWith('image/')
  )
  if (remainingAttachments.length === attachments.length) return null
  if (!activeVersion.content.trim() && remainingAttachments.length === 0) {
    return null
  }

  const updatedUserMessage = appendMessageVersion(
    userMessage,
    activeVersion.content,
    remainingAttachments.length > 0 ? remainingAttachments : undefined
  )
  const updatedMessages = messages.map((message) =>
    message.key === userMessage.key ? updatedUserMessage : message
  )

  return createRegeneratedMessages(updatedMessages, updatedUserMessage.key)
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

  const updatedMessages = messages.map((message) => {
    if (message.key !== messageKey) return message
    const updated = {
      ...appendMessageVersion(message, content),
      createdAt: shouldSubmit ? submittedAt : message.createdAt,
    }
    // The search snapshot belonged to the prompt that was actually searched.
    // Editing the turn makes it stale, so the edited version never replays old
    // hits as if they answered the new text.
    if (updated.from === MESSAGE_ROLES.USER) {
      delete updated.search
    }
    return updated
  })

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
