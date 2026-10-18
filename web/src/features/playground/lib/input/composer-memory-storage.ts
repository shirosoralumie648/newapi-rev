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
  PLAYGROUND_INPUT_DRAFT_MAX_CHARS,
  PLAYGROUND_INPUT_DRAFT_MAX_ENTRIES,
  PLAYGROUND_INPUT_HISTORY_ENTRY_MAX_CHARS,
  PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES,
  STORAGE_KEYS,
} from '../../constants'

// Browser-owned composer memory, scoped to one account. Drafts belong to one
// conversation and history is shared across the account's conversations; both
// are convenience copies only. The stored session state and the server remain
// the source of the conversation itself, so losing this data never loses a
// message.
export const COMPOSER_MEMORY_VERSION = 1

type StoredEnvelope = {
  version: number
  data: unknown
}

type StoredDraft = {
  sessionId: string
  text: string
  updatedAt: number
}

function scopedStorageKey(
  base: string,
  userId: number | null | undefined
): string | null {
  return userId == null ? null : `${base}:${userId}`
}

function readStoredData(key: string): unknown {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredEnvelope>
    if (parsed.version !== COMPOSER_MEMORY_VERSION || !('data' in parsed)) {
      return null
    }
    return parsed.data
  } catch {
    return null
  }
}

function writeStoredData(key: string, data: unknown): void {
  if (typeof window === 'undefined') return
  try {
    const payload: StoredEnvelope = {
      version: COMPOSER_MEMORY_VERSION,
      data,
    }
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Browser storage is a convenience copy; a full or unavailable store must
    // never break typing.
  }
}

function parseStoredDrafts(value: unknown): StoredDraft[] {
  if (!Array.isArray(value)) return []
  const drafts: StoredDraft[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Partial<StoredDraft>
    if (
      typeof candidate.sessionId !== 'string' ||
      typeof candidate.text !== 'string' ||
      typeof candidate.updatedAt !== 'number'
    ) {
      continue
    }
    drafts.push({
      sessionId: candidate.sessionId,
      text: candidate.text,
      updatedAt: candidate.updatedAt,
    })
  }
  return drafts
}

function parseStoredHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES)
}

/** The saved drafts of one account, keyed by conversation id. */
export function loadComposerDrafts(
  userId: number | null | undefined
): Map<string, string> {
  const key = scopedStorageKey(STORAGE_KEYS.INPUT_DRAFTS, userId)
  const drafts = new Map<string, string>()
  if (!key) return drafts
  for (const draft of parseStoredDrafts(readStoredData(key))) {
    drafts.set(draft.sessionId, draft.text)
  }
  return drafts
}

/**
 * Stores the un-submitted text of one conversation. Text beyond the draft cap
 * is not stored (it stays in the composer), and empty text removes the draft.
 * The entry list is bounded so an account cannot accumulate one row per
 * visited conversation forever.
 */
export function saveComposerDraft(
  userId: number | null | undefined,
  sessionId: string,
  text: string
): void {
  const key = scopedStorageKey(STORAGE_KEYS.INPUT_DRAFTS, userId)
  if (!key || !sessionId) return
  const drafts = parseStoredDrafts(readStoredData(key))
  const remaining = drafts.filter((draft) => draft.sessionId !== sessionId)
  if (text.trim() !== '' && text.length <= PLAYGROUND_INPUT_DRAFT_MAX_CHARS) {
    remaining.unshift({ sessionId, text, updatedAt: Date.now() })
  }
  writeStoredData(key, remaining.slice(0, PLAYGROUND_INPUT_DRAFT_MAX_ENTRIES))
}

/** The account's recalled inputs, newest first. */
export function loadComposerHistory(
  userId: number | null | undefined
): string[] {
  const key = scopedStorageKey(STORAGE_KEYS.INPUT_HISTORY, userId)
  if (!key) return []
  return parseStoredHistory(readStoredData(key))
}

/**
 * Records one successfully sent text as the newest history entry and returns
 * the updated list. The entry is de-duplicated so recalling and resending the
 * same prompt moves it to the front instead of piling up, and an overlong
 * prompt is skipped because it is unlikely to be recalled.
 */
export function rememberComposerHistoryEntry(
  userId: number | null | undefined,
  text: string
): string[] {
  const history = loadComposerHistory(userId)
  const entry = text.trim()
  if (!entry || entry.length > PLAYGROUND_INPUT_HISTORY_ENTRY_MAX_CHARS) {
    return history
  }
  const next = [text, ...history.filter((item) => item !== text)].slice(
    0,
    PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES
  )
  const key = scopedStorageKey(STORAGE_KEYS.INPUT_HISTORY, userId)
  if (key) writeStoredData(key, next)
  return next
}
