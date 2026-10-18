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
import { t } from 'i18next'
import { nanoid } from 'nanoid'

import {
  ERROR_MESSAGES,
  MESSAGE_ROLES,
  MESSAGE_STATUS,
  PLAYGROUND_PARALLEL_MAX_MODELS,
} from '../../constants'
import type {
  ChatCompletionResponse,
  Message,
  MessageAttachment,
  MessageUsage,
  MessageVersion,
} from '../../types'
import { applyChatCompletionChoice } from './message-streaming-utils'
import { completeAssistantTiming } from './message-timing-utils'
import { createUserMessage } from './message-utils'

type ChatCompletionChoice = ChatCompletionResponse['choices'][number]

/**
 * Whether the message is the group one parallel comparison produced. Only the
 * assistant path stores it; user and system messages never compare models.
 */
export function isParallelMessage(message: Message | undefined): boolean {
  return message?.from === MESSAGE_ROLES.ASSISTANT && message.parallel === true
}

/**
 * Normalize the models one comparison may hold: trimmed, deduplicated in the
 * order the user picked and bounded by the client ceiling. The server applies
 * the owner's effective policy to the same list when the group is stored.
 */
export function normalizeParallelModels(models: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of models) {
    const model = raw.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    normalized.push(model)
  }
  return normalized.slice(0, PLAYGROUND_PARALLEL_MAX_MODELS)
}

/**
 * One version of a comparison: empty until its request answers, labelled with
 * the model it waits for.
 */
export function createParallelMessageVersion(model: string): MessageVersion {
  return {
    id: nanoid(),
    content: '',
    model,
    status: MESSAGE_STATUS.LOADING,
  }
}

/**
 * The assistant group of one comparison: one pending version per model. It is
 * a single message, so the conversation keeps every compared reply as a
 * selectable branch and the chosen one continues the conversation.
 */
export function createParallelReplyMessage(
  models: string[],
  startedAt: number = Date.now()
): Message {
  return {
    key: nanoid(),
    from: MESSAGE_ROLES.ASSISTANT,
    parallel: true,
    createdAt: startedAt,
    startedAt,
    isReasoningComplete: false,
    isContentComplete: false,
    isReasoningStreaming: false,
    status: MESSAGE_STATUS.LOADING,
    versions: normalizeParallelModels(models).map((model) =>
      createParallelMessageVersion(model)
    ),
  }
}

/**
 * Append the user turn and the comparison group that answers it. Both share
 * the submit timestamp so every compared reply reports the same start.
 */
export function appendParallelMessagePair(
  messages: Message[],
  content: string,
  attachments: MessageAttachment[] | undefined,
  models: string[],
  submittedAt: number = Date.now()
): Message[] {
  return [
    ...messages,
    createUserMessage(content, submittedAt, attachments),
    createParallelReplyMessage(models, submittedAt),
  ]
}

function getVersionStatus(version: MessageVersion): MessageStatus {
  return version.status ?? MESSAGE_STATUS.COMPLETE
}

function isPendingVersion(version: MessageVersion): boolean {
  const status = getVersionStatus(version)
  return (
    status === MESSAGE_STATUS.LOADING || status === MESSAGE_STATUS.STREAMING
  )
}

export function hasPendingParallelVersions(message: Message): boolean {
  return message.versions.some(isPendingVersion)
}

function updateParallelVersion(
  message: Message,
  versionIndex: number,
  update: (version: MessageVersion) => MessageVersion
): Message {
  const version = message.versions[versionIndex]
  if (!version) return message

  return {
    ...message,
    versions: message.versions.map((item, index) =>
      index === versionIndex ? update(item) : item
    ),
  }
}

/**
 * Resolve the group status once a version settles: still pending while any
 * request runs, failed only when every version failed, complete otherwise.
 * Timing is completed exactly when nothing is pending anymore.
 */
export function settleParallelMessage(
  message: Message,
  completedAt: number = Date.now()
): Message {
  if (!isParallelMessage(message)) return message

  if (hasPendingParallelVersions(message)) {
    return {
      ...message,
      status: MESSAGE_STATUS.LOADING,
      completedAt: undefined,
      durationMs: undefined,
    }
  }

  const allFailed =
    message.versions.length > 0 &&
    message.versions.every(
      (version) => getVersionStatus(version) === MESSAGE_STATUS.ERROR
    )

  return completeAssistantTiming(
    {
      ...message,
      status: allFailed ? MESSAGE_STATUS.ERROR : MESSAGE_STATUS.COMPLETE,
      isContentComplete: true,
      isReasoningComplete: true,
      isReasoningStreaming: false,
    },
    completedAt
  )
}

/**
 * Store the answer of one compared model on its own version. The choice is
 * finalized through the ordinary reply path (thinking tags, tool calls), so a
 * compared reply renders exactly like a normal one.
 */
export function applyParallelCompletionChoice(
  message: Message,
  versionIndex: number,
  choice: ChatCompletionChoice,
  record?: { requestId?: string; usage?: MessageUsage }
): Message {
  const version = message.versions[versionIndex]
  if (!version) return message

  const scoped: Message = {
    ...message,
    parallel: false,
    status: MESSAGE_STATUS.STREAMING,
    versions: [version],
    activeVersionIndex: 0,
  }
  const completed = applyChatCompletionChoice(scoped, choice)
  const settledVersion: MessageVersion = {
    ...completed.versions[0],
    model: version.model,
    status: MESSAGE_STATUS.COMPLETE,
    errorCode: null,
  }
  if (record?.requestId) {
    settledVersion.requestId = record.requestId
  }
  if (record?.usage) {
    settledVersion.usage = record.usage
  }

  return settleParallelMessage(
    updateParallelVersion(message, versionIndex, () => settledVersion)
  )
}

/**
 * Mark one compared reply as failed. The error text is stored in the version
 * content so it survives a reload and renders through the shared error view.
 * A failed attempt can still be billed, so the relay request id that arrived
 * before the failure is kept on the version.
 */
export function applyParallelVersionError(
  message: Message,
  versionIndex: number,
  errorMessage: string,
  errorCode?: string | null,
  record?: { requestId?: string }
): Message {
  const title = t(ERROR_MESSAGES.API_REQUEST_ERROR)
  const detail = errorMessage.trim()
  return settleParallelMessage(
    updateParallelVersion(message, versionIndex, (version) => ({
      ...version,
      content: detail ? `${title}: ${detail}` : title,
      status: MESSAGE_STATUS.ERROR,
      errorCode: errorCode ?? null,
      ...(record?.requestId ? { requestId: record.requestId } : {}),
    }))
  )
}

/**
 * Put one version back into its pending state before a single-model retry.
 */
export function startParallelVersionRetry(
  message: Message,
  versionIndex: number
): Message {
  return updateParallelVersion(message, versionIndex, (version) => ({
    ...version,
    content: '',
    requestId: undefined,
    usage: undefined,
    toolCalls: undefined,
    status: MESSAGE_STATUS.LOADING,
    errorCode: null,
  }))
}

/**
 * Settle every pending version as interrupted. It repairs a comparison that a
 * reload or a stop left behind: the completed answers are kept untouched and
 * only the replies that never arrived are marked failed.
 */
export function interruptParallelMessage(
  message: Message,
  completedAt: number = Date.now()
): Message {
  if (!isParallelMessage(message) || !hasPendingParallelVersions(message)) {
    return message
  }

  const versions = message.versions.map((version) =>
    isPendingVersion(version)
      ? {
          ...version,
          content: `${t(ERROR_MESSAGES.API_REQUEST_ERROR)}: ${t(
            ERROR_MESSAGES.INTERRUPTED
          )}`,
          status: MESSAGE_STATUS.ERROR,
          errorCode: null,
        }
      : version
  )

  return settleParallelMessage({ ...message, versions }, completedAt)
}

/**
 * The conversation slice one comparison request carries: everything stored
 * before the group, including the user turn it answers. Retrying a single
 * model reuses the same prefix so the compared replies stay comparable.
 */
export function getParallelPromptMessages(
  messages: Message[],
  messageKey: string
): Message[] {
  const index = messages.findIndex((message) => message.key === messageKey)
  return index === -1 ? messages : messages.slice(0, index)
}
