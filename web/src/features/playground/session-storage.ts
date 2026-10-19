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

import { useAuthStore } from '@/stores/auth-store'

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
  DEFAULT_SESSION_TITLE,
  MAX_STORED_SESSIONS,
  STORAGE_KEYS,
} from './constants'
import {
  normalizeContextSettings,
  normalizeContextSummary,
} from './lib/context/playground-context'
import {
  clearLegacyPlaygroundData,
  normalizeMessagesForStorage,
} from './lib/storage/storage'
import {
  MAX_STORED_SESSIONS_BYTES,
  STORAGE_VERSION,
  messagesSchema,
  playgroundSessionSchema,
  parameterEnabledSchema,
  playgroundConfigSchema,
} from './lib/storage/storage-schema'
import type {
  Message,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  PlaygroundSession,
  PlaygroundSessionsState,
} from './types'

type StoredEnvelope = {
  version: number
  data: unknown
}

function createSession(
  config: PlaygroundConfig = DEFAULT_CONFIG,
  parameterEnabled: ParameterEnabled = DEFAULT_PARAMETER_ENABLED,
  systemPrompt = '',
  context: PlaygroundContextSettings = DEFAULT_CONTEXT_SETTINGS,
  contextSummary: PlaygroundContextSummary | null = null,
  openingMessage = '',
  suggestedQuestions: string[] = []
): PlaygroundSession {
  const now = Date.now()
  return {
    id: nanoid(),
    title: DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
    config: { ...config },
    parameterEnabled: { ...parameterEnabled },
    systemPrompt,
    openingMessage,
    suggestedQuestions: [...suggestedQuestions],
    context: { ...context },
    contextSummary,
    messages: [],
  }
}

function getUserStorageKey(userId: number | null | undefined): string | null {
  return userId == null ? null : `${STORAGE_KEYS.SESSIONS}:${userId}`
}

function getCurrentUserId(): number | null {
  return useAuthStore.getState().auth.user?.id ?? null
}

function normalizeSession(value: unknown): PlaygroundSession | null {
  const parsed = playgroundSessionSchema.safeParse(value)
  if (!parsed.success) return null

  return {
    ...parsed.data,
    title: parsed.data.title.trim(),
    systemPrompt: parsed.data.systemPrompt ?? '',
    openingMessage: parsed.data.openingMessage ?? '',
    suggestedQuestions: parsed.data.suggestedQuestions ?? [],
    context: normalizeContextSettings(parsed.data.context),
    contextSummary: normalizeContextSummary(parsed.data.contextSummary),
    messages: normalizeMessagesForStorage(parsed.data.messages),
  }
}

function getSerializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function limitSessionsToStorageBytes(
  sessions: PlaygroundSession[],
  activeSessionId: string
): PlaygroundSessionsState {
  const limitedSessions = [...sessions]
  let nextActiveSessionId = activeSessionId

  while (
    limitedSessions.length > 1 &&
    getSerializedByteLength({
      activeSessionId: nextActiveSessionId,
      sessions: limitedSessions,
    }) > MAX_STORED_SESSIONS_BYTES
  ) {
    limitedSessions.pop()
    if (
      !limitedSessions.some((session) => session.id === nextActiveSessionId)
    ) {
      nextActiveSessionId = limitedSessions[0].id
    }
  }

  if (!limitedSessions.some((session) => session.id === nextActiveSessionId)) {
    nextActiveSessionId = limitedSessions[0].id
  }

  return {
    activeSessionId: nextActiveSessionId,
    sessions: limitedSessions,
  }
}

function migrateStoredSession(value: unknown): PlaygroundSession | null {
  const parsed = playgroundSessionSchema.safeParse(value)
  if (parsed.success) {
    return normalizeSession(parsed.data)
  }

  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PlaygroundSession>
  if (
    typeof source.id !== 'string' ||
    typeof source.title !== 'string' ||
    typeof source.createdAt !== 'number' ||
    typeof source.updatedAt !== 'number' ||
    !source.config ||
    !source.parameterEnabled ||
    !Array.isArray(source.messages)
  ) {
    return null
  }

  const config = playgroundConfigSchema.safeParse({
    ...DEFAULT_CONFIG,
    ...(source.config as object),
  })
  const parameterEnabled = parameterEnabledSchema.safeParse({
    ...DEFAULT_PARAMETER_ENABLED,
    ...(source.parameterEnabled as object),
  })
  const messages = messagesSchema.safeParse(source.messages)
  if (!config.success || !parameterEnabled.success || !messages.success) {
    return null
  }

  return normalizeSession({
    id: source.id,
    title: source.title,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    config: config.data,
    parameterEnabled: parameterEnabled.data,
    systemPrompt:
      typeof source.systemPrompt === 'string' ? source.systemPrompt : undefined,
    openingMessage:
      typeof source.openingMessage === 'string'
        ? source.openingMessage
        : undefined,
    suggestedQuestions: Array.isArray(source.suggestedQuestions)
      ? source.suggestedQuestions
      : undefined,
    context: source.context,
    contextSummary: source.contextSummary,
    messages: messages.data,
  })
}

function parseStoredState(value: string): PlaygroundSessionsState | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredEnvelope> &
      Partial<PlaygroundSessionsState>
    const hasEnvelope = parsed.version !== undefined || 'data' in parsed

    if (hasEnvelope) {
      if (
        typeof parsed.version !== 'number' ||
        parsed.version < 1 ||
        parsed.version > STORAGE_VERSION ||
        !('data' in parsed)
      ) {
        return null
      }
    }

    const data = hasEnvelope ? parsed.data : parsed
    const source = data as Partial<PlaygroundSessionsState>
    if (!Array.isArray(source.sessions)) return null

    const sessions = source.sessions
      .slice(0, MAX_STORED_SESSIONS)
      .map(migrateStoredSession)
      .filter((session): session is PlaygroundSession => session !== null)
    if (sessions.length === 0) return null

    const requestedActiveSessionId =
      typeof source.activeSessionId === 'string' ? source.activeSessionId : null
    const activeSessionId =
      requestedActiveSessionId &&
      sessions.some((session) => session.id === requestedActiveSessionId)
        ? requestedActiveSessionId
        : sessions[0].id

    return limitSessionsToStorageBytes(sessions, activeSessionId)
  } catch {
    return null
  }
}

export function loadSessionsState(
  legacy: {
    config: PlaygroundConfig
    parameterEnabled: ParameterEnabled
    messages: Message[]
  },
  userId: number | null = getCurrentUserId(),
  /**
   * Account-level new-conversation defaults. They only seed the initial
   * conversation when this browser has never stored one for the account;
   * stored conversations always win.
   */
  newSessionDefaults?: {
    config: PlaygroundConfig
    parameterEnabled: ParameterEnabled
    systemPrompt: string
  } | null
): PlaygroundSessionsState {
  const migratedSession = createSession(
    newSessionDefaults?.config ?? legacy.config,
    newSessionDefaults?.parameterEnabled ?? legacy.parameterEnabled,
    newSessionDefaults?.systemPrompt ?? ''
  )
  migratedSession.messages = normalizeMessagesForStorage(legacy.messages)
  const fallbackState: PlaygroundSessionsState = {
    activeSessionId: migratedSession.id,
    sessions: [migratedSession],
  }

  if (typeof window === 'undefined') return fallbackState

  const key = getUserStorageKey(userId)
  if (!key) return fallbackState

  try {
    const stored = window.localStorage.getItem(key)
    if (stored) {
      if (
        new TextEncoder().encode(stored).byteLength <= MAX_STORED_SESSIONS_BYTES
      ) {
        const state = parseStoredState(stored)
        if (state) {
          try {
            const parsed = JSON.parse(stored) as Partial<StoredEnvelope>
            if (parsed.version !== STORAGE_VERSION) {
              saveSessionsState(state, userId)
            }
            clearLegacyPlaygroundData(userId)
          } catch {
            // parseStoredState already validated the stored payload.
          }
          return state
        }
      }
      if (saveSessionsState(fallbackState, userId)) {
        clearLegacyPlaygroundData(userId)
      }
      return fallbackState
    }
  } catch {
    return fallbackState
  }

  if (saveSessionsState(fallbackState, userId)) {
    clearLegacyPlaygroundData(userId)
  }
  return fallbackState
}

export function saveSessionsState(
  state: PlaygroundSessionsState,
  userId: number | null = getCurrentUserId()
): boolean {
  if (typeof window === 'undefined') return false
  const key = getUserStorageKey(userId)
  if (!key) return false

  try {
    const managed = state.sessions.some(
      (session) => session.server || session.syncPending !== undefined
    )
    const ordered = managed
      ? [...state.sessions].sort((a, b) => {
          const priority = (session: PlaygroundSession) => {
            if (session.syncPending || !session.server) return 2
            return session.id === state.activeSessionId ? 1 : 0
          }
          return priority(b) - priority(a)
        })
      : state.sessions
    const sessions = ordered
      .slice(0, MAX_STORED_SESSIONS)
      .map(normalizeSession)
      .filter((session): session is PlaygroundSession => session !== null)
    if (sessions.length === 0) return false

    const activeSessionId = sessions.some(
      (session) => session.id === state.activeSessionId
    )
      ? state.activeSessionId
      : sessions[0].id
    const limitedState = limitSessionsToStorageBytes(
      sessions,
      activeSessionId ?? sessions[0].id
    )
    const payload: StoredEnvelope = {
      version: STORAGE_VERSION,
      data: limitedState,
    }
    if (
      managed &&
      state.sessions.some(
        (session) =>
          (session.syncPending || !session.server) &&
          !limitedState.sessions.some((item) => item.id === session.id)
      )
    ) {
      return false
    }
    if (getSerializedByteLength(payload) > MAX_STORED_SESSIONS_BYTES) {
      return false
    }
    window.localStorage.setItem(key, JSON.stringify(payload))
    return true
  } catch {
    // Keep the active in-memory session when browser storage is unavailable.
    return false
  }
}

export function createEmptySession(
  config: PlaygroundConfig,
  parameterEnabled: ParameterEnabled,
  systemPrompt = '',
  context: PlaygroundContextSettings = DEFAULT_CONTEXT_SETTINGS,
  contextSummary: PlaygroundContextSummary | null = null,
  openingMessage = '',
  suggestedQuestions: string[] = []
): PlaygroundSession {
  return createSession(
    config,
    parameterEnabled,
    systemPrompt,
    context,
    contextSummary,
    openingMessage,
    suggestedQuestions
  )
}
