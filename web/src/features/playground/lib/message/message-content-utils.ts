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
import type { Message, MessageVersion } from '../../types'
import { parseThinkTags } from './message-reasoning-utils'
import { getCurrentVersion } from './message-utils'

type MessageContentStateBase = {
  displayContent: string
  hasSources: boolean
  isAssistant: boolean
  showLoader: boolean
  showMessageContent: boolean
  sources: NonNullable<Message['sources']>
}

type MessageContentState = MessageContentStateBase &
  (
    | {
        hasReasoning: true
        reasoningContent: string
      }
    | {
        hasReasoning: false
        reasoningContent: undefined
      }
  )

function shouldShowMessageLoader(
  message: Message,
  isAssistant: boolean,
  versionContent: string
): boolean {
  return (
    isAssistant &&
    !message.isReasoningStreaming &&
    (message.status === MESSAGE_STATUS.LOADING ||
      (message.status === MESSAGE_STATUS.STREAMING && !versionContent))
  )
}

function shouldShowMessageContent(
  message: Message,
  versionContent: string,
  version: MessageVersion
): boolean {
  const hasAttachments = (version.attachments?.length ?? 0) > 0
  const hasToolCalls = (version.toolCalls?.length ?? 0) > 0
  return (
    (message.from === MESSAGE_ROLES.USER || !message.isReasoningStreaming) &&
    (versionContent.length > 0 || hasAttachments || hasToolCalls)
  )
}

function getDisplayContent(message: Message, versionContent: string): string {
  if (message.from !== MESSAGE_ROLES.ASSISTANT) {
    return versionContent
  }

  if (!versionContent.includes('<think>')) {
    return versionContent
  }

  return parseThinkTags(versionContent).visibleContent
}

/**
 * Resolve the display state for one rendered version. The version is looked up
 * by default so plain callers stay on the active branch, while branch views
 * pass the version they render: attachments and tool calls belong to a version.
 */
export function getMessageContentState(
  message: Message,
  versionContent: string,
  version: MessageVersion = getCurrentVersion(message)
): MessageContentState {
  const isAssistant = message.from === MESSAGE_ROLES.ASSISTANT
  const sources = message.sources ?? []
  const reasoningContent = isAssistant ? message.reasoning?.content : undefined
  const showLoader = shouldShowMessageLoader(
    message,
    isAssistant,
    versionContent
  )
  const showMessageContent = shouldShowMessageContent(
    message,
    versionContent,
    version
  )

  const baseState: MessageContentStateBase = {
    displayContent: getDisplayContent(message, versionContent),
    hasSources: sources.length > 0,
    isAssistant,
    showLoader,
    showMessageContent,
    sources,
  }

  if (reasoningContent) {
    return {
      ...baseState,
      hasReasoning: true,
      reasoningContent,
    }
  }

  return {
    ...baseState,
    hasReasoning: false,
    reasoningContent: undefined,
  }
}
