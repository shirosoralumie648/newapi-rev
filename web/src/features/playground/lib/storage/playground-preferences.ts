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
import { z } from 'zod'

import {
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  PLAYGROUND_NEW_SESSION_PROMPT_MAX_BYTES,
  PLAYGROUND_PREFERENCE_OVERRIDE_MAX_ENTRIES,
  PLAYGROUND_TOOL_EXECUTION_DEFAULT_ENABLED,
  PLAYGROUND_TOOL_EXECUTION_DEFAULT_MAX_ROUNDS,
  PLAYGROUND_TOOL_EXECUTION_MAX_ROUNDS,
  PLAYGROUND_TOOL_EXECUTION_MIN_ROUNDS,
  STORAGE_KEYS,
} from '../../constants'
import type { ParameterEnabled, PlaygroundConfig } from '../../types'
import {
  parameterEnabledSchema,
  playgroundConfigSchema,
} from './storage-schema'

const PREFERENCES_VERSION = 1

type StoredEnvelope = { version: number; data: unknown }

/**
 * The account-level starting point of a new conversation: the settings of the
 * conversation the account last configured. It is a client-side preference;
 * the server stays the source of truth for the stored conversations
 * themselves.
 */
export interface PlaygroundNewSessionDefaults {
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  systemPrompt: string
}

/**
 * Auto read-aloud preference of one account: the default for new
 * conversations plus the explicit per-conversation overrides.
 */
export interface PlaygroundAutoReadPreferences {
  defaultEnabled: boolean
  overrides: Record<string, boolean>
}

/**
 * Automatic conversation naming preference of one account: the default for new
 * conversations plus the explicit per-conversation overrides. Naming is on by
 * default; the conversation switch only writes an override when it differs.
 */
export interface PlaygroundAutoTitlePreferences {
  defaultEnabled: boolean
  overrides: Record<string, boolean>
}

/**
 * The account-level tool loop switch and its continuation round cap. Off by
 * default because automatic continuation sends billed requests without a
 * second click.
 */
export interface PlaygroundToolExecutionPreferences {
  enabled: boolean
  maxRounds: number
}

const newSessionDefaultsSchema = z.object({
  config: playgroundConfigSchema,
  parameterEnabled: parameterEnabledSchema,
  systemPrompt: z.string(),
})

const autoReadPreferencesSchema = z.object({
  defaultEnabled: z.boolean(),
  overrides: z.unknown(),
})

const autoTitlePreferencesSchema = z.object({
  defaultEnabled: z.boolean(),
  overrides: z.record(z.string(), z.boolean()),
})

const toolExecutionPreferencesSchema = z.object({
  enabled: z.boolean(),
  maxRounds: z.number().int(),
})

function prefixedKey(key: string, userId: number): string {
  return `${key}:${userId}`
}

function readEnvelope(key: string, userId: number): unknown {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(prefixedKey(key, userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredEnvelope>
    if (parsed.version !== PREFERENCES_VERSION || !('data' in parsed)) {
      return null
    }
    return parsed.data
  } catch {
    return null
  }
}

function writeEnvelope(key: string, userId: number, data: unknown): boolean {
  if (typeof window === 'undefined') return false
  try {
    const payload: StoredEnvelope = { version: PREFERENCES_VERSION, data }
    window.localStorage.setItem(
      prefixedKey(key, userId),
      JSON.stringify(payload)
    )
    return true
  } catch {
    return false
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function loadNewSessionDefaults(
  userId: number | null
): PlaygroundNewSessionDefaults | null {
  if (userId === null) return null
  const parsed = newSessionDefaultsSchema.safeParse(
    readEnvelope(STORAGE_KEYS.NEW_SESSION_DEFAULTS, userId)
  )
  if (!parsed.success) return null
  if (
    byteLength(parsed.data.systemPrompt) >
    PLAYGROUND_NEW_SESSION_PROMPT_MAX_BYTES
  ) {
    return null
  }
  return {
    config: { ...DEFAULT_CONFIG, ...parsed.data.config },
    parameterEnabled: {
      ...DEFAULT_PARAMETER_ENABLED,
      ...parsed.data.parameterEnabled,
    },
    systemPrompt: parsed.data.systemPrompt,
  }
}

export function saveNewSessionDefaults(
  userId: number | null,
  defaults: PlaygroundNewSessionDefaults
): boolean {
  if (userId === null) return false
  if (
    byteLength(defaults.systemPrompt) > PLAYGROUND_NEW_SESSION_PROMPT_MAX_BYTES
  ) {
    return false
  }
  return writeEnvelope(STORAGE_KEYS.NEW_SESSION_DEFAULTS, userId, {
    config: defaults.config,
    parameterEnabled: defaults.parameterEnabled,
    systemPrompt: defaults.systemPrompt,
  })
}

function normalizeOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] =>
      entry[0].length > 0 &&
      entry[0].length <= 128 &&
      typeof entry[1] === 'boolean'
  )
  return Object.fromEntries(
    entries.slice(0, PLAYGROUND_PREFERENCE_OVERRIDE_MAX_ENTRIES)
  )
}

export function loadAutoReadPreferences(
  userId: number | null
): PlaygroundAutoReadPreferences {
  if (userId === null) return { defaultEnabled: false, overrides: {} }
  const parsed = autoReadPreferencesSchema.safeParse(
    readEnvelope(STORAGE_KEYS.AUTO_READ_ALOUD, userId)
  )
  if (!parsed.success) return { defaultEnabled: false, overrides: {} }
  return {
    defaultEnabled: parsed.data.defaultEnabled,
    overrides: normalizeOverrides(parsed.data.overrides),
  }
}

export function saveAutoReadPreferences(
  userId: number | null,
  preferences: PlaygroundAutoReadPreferences
): boolean {
  if (userId === null) return false
  return writeEnvelope(STORAGE_KEYS.AUTO_READ_ALOUD, userId, {
    defaultEnabled: preferences.defaultEnabled,
    overrides: normalizeOverrides(preferences.overrides),
  })
}

export function loadAutoTitlePreferences(
  userId: number | null
): PlaygroundAutoTitlePreferences {
  if (userId === null) return { defaultEnabled: true, overrides: {} }
  const parsed = autoTitlePreferencesSchema.safeParse(
    readEnvelope(STORAGE_KEYS.AUTO_TITLE, userId)
  )
  if (!parsed.success) return { defaultEnabled: true, overrides: {} }
  return {
    defaultEnabled: parsed.data.defaultEnabled,
    overrides: normalizeOverrides(parsed.data.overrides),
  }
}

export function saveAutoTitlePreferences(
  userId: number | null,
  preferences: PlaygroundAutoTitlePreferences
): boolean {
  if (userId === null) return false
  return writeEnvelope(STORAGE_KEYS.AUTO_TITLE, userId, {
    defaultEnabled: preferences.defaultEnabled,
    overrides: normalizeOverrides(preferences.overrides),
  })
}

export function loadToolExecutionPreferences(
  userId: number | null
): PlaygroundToolExecutionPreferences {
  const fallback: PlaygroundToolExecutionPreferences = {
    enabled: PLAYGROUND_TOOL_EXECUTION_DEFAULT_ENABLED,
    maxRounds: PLAYGROUND_TOOL_EXECUTION_DEFAULT_MAX_ROUNDS,
  }
  if (userId === null) return fallback
  const parsed = toolExecutionPreferencesSchema.safeParse(
    readEnvelope(STORAGE_KEYS.TOOL_EXECUTION, userId)
  )
  if (!parsed.success) return fallback
  return {
    enabled: parsed.data.enabled,
    maxRounds: Math.min(
      PLAYGROUND_TOOL_EXECUTION_MAX_ROUNDS,
      Math.max(PLAYGROUND_TOOL_EXECUTION_MIN_ROUNDS, parsed.data.maxRounds)
    ),
  }
}

export function saveToolExecutionPreferences(
  userId: number | null,
  preferences: PlaygroundToolExecutionPreferences
): boolean {
  if (userId === null) return false
  return writeEnvelope(STORAGE_KEYS.TOOL_EXECUTION, userId, {
    enabled: preferences.enabled,
    maxRounds: Math.min(
      PLAYGROUND_TOOL_EXECUTION_MAX_ROUNDS,
      Math.max(PLAYGROUND_TOOL_EXECUTION_MIN_ROUNDS, preferences.maxRounds)
    ),
  })
}
