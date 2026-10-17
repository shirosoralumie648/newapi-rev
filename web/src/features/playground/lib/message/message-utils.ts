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
import { nanoid } from 'nanoid'

import { MESSAGE_ROLES, MESSAGE_STATUS } from '../../constants'
import type {
  Message,
  MessageAttachment,
  MessageVersion,
  ChatCompletionMessage,
  ContentPart,
} from '../../types'
import { getPlaygroundAttachmentDataUrl } from '../attachment-store'

/**
 * Create a new message version
 */
export function createMessageVersion(
  content: string,
  attachments?: MessageAttachment[]
): MessageVersion {
  const version: MessageVersion = {
    id: nanoid(),
    content,
  }
  if (attachments && attachments.length > 0) {
    version.attachments = attachments
  }
  return version
}

/**
 * Resolve the active version index. Missing or out-of-range indexes fall back
 * to the first version so legacy snapshots stay readable.
 */
export function getActiveVersionIndex(message: Message): number {
  if (message.versions.length === 0) return 0

  const index = message.activeVersionIndex ?? 0
  if (index < 0 || index >= message.versions.length) return 0

  return index
}

/**
 * Get the active version from a message. Editing and regenerating append a new
 * version and select it, so history stays available as switchable branches.
 */
export function getCurrentVersion(message: Message): MessageVersion {
  return (
    message.versions[getActiveVersionIndex(message)] || {
      id: 'default',
      content: '',
    }
  )
}

/**
 * Get displayable content from the current message version.
 */
export function getMessageContent(message: Message): string {
  return getCurrentVersion(message).content
}

/**
 * Check whether a message has non-empty content in its current version.
 */
export function hasMessageContent(message: Message): boolean {
  return getMessageContent(message).trim() !== ''
}

/**
 * Update the content of the active version in place, preserving every other
 * version so streaming never discards an existing branch.
 */
export function updateCurrentVersionContent(
  message: Message,
  content: string
): Message {
  const activeIndex = getActiveVersionIndex(message)
  const currentVersion = message.versions[activeIndex]

  if (!currentVersion) {
    return {
      ...message,
      versions: [createMessageVersion(content)],
      activeVersionIndex: 0,
    }
  }

  return {
    ...message,
    versions: message.versions.map((version, index) =>
      index === activeIndex ? { ...version, content } : version
    ),
  }
}

/**
 * Append a new version to a message and select it, keeping older versions so
 * edits and regenerations remain available as switchable branches.
 */
export function appendMessageVersion(
  message: Message,
  content: string,
  attachments?: MessageAttachment[]
): Message {
  const versions = [
    ...message.versions,
    createMessageVersion(content, attachments),
  ]

  return {
    ...message,
    versions,
    activeVersionIndex: versions.length - 1,
  }
}

/**
 * Select an existing version as active. Out-of-range indexes are ignored.
 */
export function setActiveMessageVersion(
  message: Message,
  versionIndex: number
): Message {
  if (versionIndex < 0 || versionIndex >= message.versions.length) {
    return message
  }

  return { ...message, activeVersionIndex: versionIndex }
}

/**
 * Create a user message
 */
export function createUserMessage(
  content: string,
  createdAt: number = Date.now(),
  attachments?: MessageAttachment[]
): Message {
  return {
    key: nanoid(),
    from: MESSAGE_ROLES.USER,
    versions: [createMessageVersion(content, attachments)],
    createdAt,
  }
}

/**
 * Create a loading assistant message
 */
export function createLoadingAssistantMessage(
  startedAt: number = Date.now()
): Message {
  return {
    key: nanoid(),
    from: MESSAGE_ROLES.ASSISTANT,
    versions: [createMessageVersion('')],
    createdAt: startedAt,
    startedAt,
    reasoning: undefined,
    isReasoningComplete: false,
    isContentComplete: false,
    isReasoningStreaming: false,
    status: MESSAGE_STATUS.LOADING,
  }
}

/**
 * Build message content with optional images
 */
export function buildMessageContent(
  text: string,
  imageUrls: string[] = []
): string | ContentPart[] {
  const validImages = imageUrls.filter((url) => url.trim() !== '')

  if (validImages.length === 0) {
    return text
  }

  const parts: ContentPart[] = [
    {
      type: 'text',
      text: text || '',
    },
    ...validImages.map((url) => ({
      type: 'image_url' as const,
      image_url: { url: url.trim() },
    })),
  ]

  return parts
}

/**
 * Extract text content from message content
 */
export function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textPart = content.find((part) => part.type === 'text')
    return textPart?.text || ''
  }

  return ''
}

/**
 * Format message for API request. Attachments contribute image parts from the
 * attachment cache; prepare the cache with ensurePlaygroundMessageAttachments
 * before building a payload for older messages.
 */
export function formatMessageForAPI(message: Message): ChatCompletionMessage {
  const currentVersion = getCurrentVersion(message)
  const imageUrls = (currentVersion.attachments ?? [])
    .filter((attachment) => attachment.mediaType.startsWith('image/'))
    .map((attachment) => getPlaygroundAttachmentDataUrl(attachment.id))
    .filter((url): url is string => Boolean(url))
  return {
    role: message.from,
    content: buildMessageContent(currentVersion.content, imageUrls),
  }
}

/**
 * Check whether the active version carries tool calls. A reply that only
 * requested a tool call has no text but is still a valid conversation turn.
 */
export function hasToolCallPayload(message: Message): boolean {
  return (getCurrentVersion(message).toolCalls?.length ?? 0) > 0
}

/**
 * Check if message is valid for API request
 * Excludes loading/streaming assistant messages and empty content
 */
export function isValidMessage(message: Message): boolean {
  if (!message || !message.from || !message.versions.length) return false

  // Exclude empty assistant messages (loading/streaming placeholders)
  if (
    message.from === MESSAGE_ROLES.ASSISTANT &&
    !hasMessageContent(message) &&
    !hasToolCallPayload(message)
  ) {
    return false
  }

  return true
}
