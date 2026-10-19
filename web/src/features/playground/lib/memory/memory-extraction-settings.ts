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
import { STORAGE_KEYS } from '../../constants'
import type { PlaygroundMemoryExtractionSettings } from '../../types'

// The extraction preference is a browser-owned convenience setting scoped to
// one account. The memories themselves live on the server; this file only
// remembers whether the owner opted in and which model should do the work.
export const MEMORY_EXTRACTION_SETTINGS_VERSION = 1
export const PLAYGROUND_MEMORY_MODEL_MAX_LENGTH = 512

export const DEFAULT_MEMORY_EXTRACTION_SETTINGS: PlaygroundMemoryExtractionSettings =
  {
    enabled: false,
    model: '',
  }

type StoredEnvelope = {
  version: number
  data: unknown
}

function scopedStorageKey(userId: number | null | undefined): string | null {
  return userId == null ? null : `${STORAGE_KEYS.MEMORY_EXTRACTION}:${userId}`
}

function parseSettings(value: unknown): PlaygroundMemoryExtractionSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_MEMORY_EXTRACTION_SETTINGS }
  }
  const source = value as Record<string, unknown>
  return {
    enabled: source.enabled === true,
    model:
      typeof source.model === 'string'
        ? source.model.slice(0, PLAYGROUND_MEMORY_MODEL_MAX_LENGTH)
        : '',
  }
}

/** The saved extraction preference of one account; extraction stays off when absent. */
export function loadMemoryExtractionSettings(
  userId: number | null | undefined
): PlaygroundMemoryExtractionSettings {
  const key = scopedStorageKey(userId)
  if (!key || typeof window === 'undefined') {
    return { ...DEFAULT_MEMORY_EXTRACTION_SETTINGS }
  }
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return { ...DEFAULT_MEMORY_EXTRACTION_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<StoredEnvelope>
    if (parsed.version !== MEMORY_EXTRACTION_SETTINGS_VERSION) {
      return { ...DEFAULT_MEMORY_EXTRACTION_SETTINGS }
    }
    return parseSettings(parsed.data)
  } catch {
    return { ...DEFAULT_MEMORY_EXTRACTION_SETTINGS }
  }
}

/** Persists the extraction preference; a failed write only loses the preference. */
export function saveMemoryExtractionSettings(
  userId: number | null | undefined,
  settings: PlaygroundMemoryExtractionSettings
): void {
  const key = scopedStorageKey(userId)
  if (!key || typeof window === 'undefined') return
  try {
    const payload: StoredEnvelope = {
      version: MEMORY_EXTRACTION_SETTINGS_VERSION,
      data: parseSettings(settings),
    }
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Browser storage is a convenience copy and must never block the panel.
  }
}
