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
  PLAYGROUND_MESSAGE_TOKEN_MAX,
  PLAYGROUND_REQUEST_ID_MAX_LENGTH,
} from '../../constants'
import type {
  Message,
  MessageUsage,
  MessageVersion,
  PlaygroundMessageCost,
} from '../../types'
import { getActiveVersionIndex, getCurrentVersion } from './message-utils'

/** Highest number of request ids one cost lookup carries; the server caps it. */
export const MESSAGE_COST_LOOKUP_MAX_REQUEST_IDS = 100

function normalizeTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  if (value < 0 || value > PLAYGROUND_MESSAGE_TOKEN_MAX) {
    return undefined
  }
  return Math.trunc(value)
}

/**
 * Normalize a relay request id for the stored generation record. An id the
 * consume log could never hold (empty or over-long) yields nothing, so a bad
 * header value cannot make the conversation snapshot unsavable.
 */
export function normalizeMessageRequestId(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > PLAYGROUND_REQUEST_ID_MAX_LENGTH) {
    return undefined
  }
  return trimmed
}

/**
 * Convert the wire usage object into the stored usage record. An incomplete
 * frame yields nothing instead of a partial record, so the display never
 * invents a token count the relay did not report.
 */
export function toMessageUsage(
  usage:
    | {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined
): MessageUsage | undefined {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens)
  const completionTokens = normalizeTokenCount(usage?.completion_tokens)
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined
  }
  const totalTokens = normalizeTokenCount(usage?.total_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens ?? promptTokens + completionTokens,
  }
}

// Re-bound an already canonical record through the same conversion, so a value
// that arrives from any other path cannot violate the stored contract.
function boundMessageUsage(usage: MessageUsage): MessageUsage | undefined {
  return toMessageUsage({
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  })
}

/**
 * Attach the generation record (relay request id and reported usage) to the
 * active version of an assistant reply. User and system messages carry no
 * generation, so they are returned unchanged. Values outside the stored
 * contract are dropped instead of being persisted.
 */
export function attachMessageVersionUsage(
  message: Message,
  update: { requestId?: string; usage?: MessageUsage }
): Message {
  if (message.from !== MESSAGE_ROLES.ASSISTANT) return message

  const requestId = normalizeMessageRequestId(update.requestId)
  const usage = update.usage ? boundMessageUsage(update.usage) : undefined
  if (!requestId && !usage) return message

  const activeIndex = getActiveVersionIndex(message)
  return {
    ...message,
    versions: message.versions.map((version, index) => {
      if (index !== activeIndex) return version
      return {
        ...version,
        ...(requestId ? { requestId } : {}),
        ...(usage ? { usage } : {}),
      }
    }),
  }
}

/**
 * Every request id the conversation can look up, deduplicated, sorted for a
 * stable query key and bounded to what one lookup accepts.
 */
export function collectMessageRequestIds(messages: Message[]): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const version of message.versions) {
      if (version.requestId) {
        ids.add(version.requestId)
      }
      if (ids.size >= MESSAGE_COST_LOOKUP_MAX_REQUEST_IDS) {
        return [...ids].sort()
      }
    }
  }
  return [...ids].sort()
}

/**
 * Usage to display for one version: what the relay reported when it generated
 * the version, otherwise the settled consume row the request id points at.
 */
export function getVersionUsage(
  version: MessageVersion,
  cost?: PlaygroundMessageCost
): MessageUsage | undefined {
  if (version.usage) return version.usage
  if (!cost) return undefined
  return {
    promptTokens: cost.promptTokens,
    completionTokens: cost.completionTokens,
    totalTokens: cost.totalTokens,
  }
}

/** Conversation totals over the version each message currently displays. */
export interface ConversationUsageSummary {
  usage: MessageUsage
  quota: number
  hasUsage: boolean
  hasCost: boolean
}

export function sumConversationUsage(
  messages: Message[],
  costs?: ReadonlyMap<string, PlaygroundMessageCost>
): ConversationUsageSummary {
  const usage: MessageUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
  let quota = 0
  let hasUsage = false
  let hasCost = false
  for (const message of messages) {
    const version = getCurrentVersion(message)
    const cost = version.requestId ? costs?.get(version.requestId) : undefined
    if (cost) {
      quota += cost.quota
      hasCost = true
    }
    const versionUsage = getVersionUsage(version, cost)
    if (!versionUsage) continue
    hasUsage = true
    usage.promptTokens += versionUsage.promptTokens
    usage.completionTokens += versionUsage.completionTokens
    usage.totalTokens += versionUsage.totalTokens
  }
  return { usage, quota, hasUsage, hasCost }
}
