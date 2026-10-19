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
  PLAYGROUND_MEMORY_CATEGORIES,
  PLAYGROUND_MEMORY_CATEGORY_LABELS,
  PLAYGROUND_MEMORY_CONTENT_MAX_CHARS,
  PLAYGROUND_MEMORY_CONTEXT_CLOSE,
  PLAYGROUND_MEMORY_CONTEXT_HINT,
  PLAYGROUND_MEMORY_CONTEXT_OPEN,
  PLAYGROUND_MEMORY_EXTRACTION_INPUT_MAX_CHARS,
  PLAYGROUND_MEMORY_EXTRACTION_MAX_CANDIDATES,
  PLAYGROUND_MEMORY_EXTRACTION_SYSTEM_PROMPT,
} from '../../constants'
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  Message,
  PlaygroundMemory,
} from '../../types'
import { getCurrentVersion } from '../message/message-utils'

/**
 * The system message that carries the owner's enabled memories into a request.
 * It is inserted right after the conversation system prompt and before the
 * conversation history, so the model reads durable facts first. An empty list
 * produces an empty string and adds nothing to the request.
 */
export function formatMemoryBlock(memories: PlaygroundMemory[]): string {
  const lines = memories
    .filter((memory) => memory.enabled && memory.content.trim() !== '')
    .map((memory) => {
      const category = memory.category.trim()
      const prefix = category ? `[${category}] ` : ''
      return `- ${prefix}${memory.content.trim()}`
    })
  if (lines.length === 0) return ''
  return [
    PLAYGROUND_MEMORY_CONTEXT_OPEN,
    PLAYGROUND_MEMORY_CONTEXT_HINT,
    ...lines,
    PLAYGROUND_MEMORY_CONTEXT_CLOSE,
  ].join('\n')
}

export interface MemoryExtractionCandidate {
  id: string
  content: string
  category: string
}

export interface MemoryExtractionPlan {
  creates: Array<{ content: string; category: string }>
  updates: Array<{ id: string; content: string; category: string }>
}

function normalizeMemoryCategory(value: unknown): string {
  return typeof value === 'string' &&
    (PLAYGROUND_MEMORY_CATEGORIES as readonly string[]).includes(value)
    ? value
    : 'general'
}

function normalizeMemoryContent(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * Parse the JSON answer of the extraction model. The model is instructed to
 * answer with `{"memories":[...]}`; code fences and a bare array are tolerated
 * because a provider may ignore the formatting instruction. Every entry is
 * bounded and validated locally before it can reach an owner-scoped write.
 */
export function parseMemoryExtractionResponse(
  content: string
): MemoryExtractionCandidate[] {
  if (!content.trim()) return []
  const unfenced = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    return []
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as { memories?: unknown }).memories
      : null
  if (!Array.isArray(entries)) return []
  const candidates: MemoryExtractionCandidate[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const source = entry as Record<string, unknown>
    const text = normalizeMemoryContent(source.content)
    if (!text || text.length > PLAYGROUND_MEMORY_CONTENT_MAX_CHARS) continue
    const key = text.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      id: typeof source.id === 'string' ? source.id.trim() : '',
      content: text,
      category: normalizeMemoryCategory(source.category),
    })
    if (candidates.length >= PLAYGROUND_MEMORY_EXTRACTION_MAX_CANDIDATES) break
  }
  return candidates
}

/**
 * Diff the extracted candidates against the stored list. An id that belongs to
 * the owner updates that memory; an unknown or empty id becomes a new memory.
 * Duplicate text never creates a second row, and the remaining account budget
 * caps how many new rows one extraction may add.
 */
export function diffMemoryCandidates(
  existing: PlaygroundMemory[],
  candidates: MemoryExtractionCandidate[],
  availableSlots: number
): MemoryExtractionPlan {
  const byId = new Map(existing.map((memory) => [memory.id, memory]))
  const knownContent = new Set(
    existing.map((memory) => memory.content.trim().toLocaleLowerCase())
  )
  const plan: MemoryExtractionPlan = { creates: [], updates: [] }
  let slots = Math.max(0, availableSlots)
  for (const candidate of candidates) {
    const matched = candidate.id ? byId.get(candidate.id) : undefined
    if (matched) {
      if (
        matched.content.trim() === candidate.content &&
        matched.category === candidate.category
      ) {
        continue
      }
      plan.updates.push({
        id: matched.id,
        content: candidate.content,
        category: candidate.category,
      })
      continue
    }
    if (slots <= 0) continue
    const key = candidate.content.toLocaleLowerCase()
    if (knownContent.has(key)) continue
    knownContent.add(key)
    plan.creates.push({
      content: candidate.content,
      category: candidate.category,
    })
    slots -= 1
  }
  return plan
}

/**
 * The non-streaming request that proposes durable notes from the owner's own
 * messages. It is an ordinary `/pg/chat/completions` call, so it is billed,
 * grouped and rate limited exactly like a conversation turn. Only user
 * messages are sent: a memory must come from the user's own data, never from
 * assistant claims. Existing memories are listed so the model can propose an
 * update instead of a duplicate.
 */
export function buildMemoryExtractionRequest(options: {
  messages: Message[]
  memories: PlaygroundMemory[]
  model: string
  group: string
}): ChatCompletionRequest {
  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: PLAYGROUND_MEMORY_EXTRACTION_SYSTEM_PROMPT },
  ]
  if (options.memories.length > 0) {
    messages.push({
      role: 'system',
      content: [
        'Existing memories (id | category | content):',
        ...options.memories.map(
          (memory) =>
            `${memory.id} | ${memory.category} | ${memory.content.trim()}`
        ),
      ].join('\n'),
    })
  }
  const userMessages: ChatCompletionMessage[] = []
  let remaining = PLAYGROUND_MEMORY_EXTRACTION_INPUT_MAX_CHARS
  for (
    let index = options.messages.length - 1;
    index >= 0 && remaining > 0;
    index--
  ) {
    const message = options.messages[index]
    if (message.from !== MESSAGE_ROLES.USER) continue
    const content = getCurrentVersion(message).content
    if (!content.trim()) continue
    const clipped =
      content.length > remaining
        ? content.slice(content.length - remaining)
        : content
    remaining -= clipped.length
    userMessages.unshift({ role: 'user', content: clipped })
  }
  messages.push(...userMessages)
  return {
    model: options.model,
    group: options.group,
    messages,
    stream: false,
  }
}

/** The localized label key of a stored category, with a safe fallback. */
export function memoryCategoryLabel(category: string): string {
  return (
    PLAYGROUND_MEMORY_CATEGORY_LABELS[category] ??
    PLAYGROUND_MEMORY_CATEGORY_LABELS.general
  )
}
