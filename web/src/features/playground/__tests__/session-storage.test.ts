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
import { afterEach, beforeEach, expect, test } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
  STORAGE_KEYS,
} from '../constants'
import { loadLegacyPlaygroundState } from '../lib/storage/storage'
import { loadSessionsState, saveSessionsState } from '../session-storage'
import type { PlaygroundSession } from '../types'

const session = (id: string, title = id): PlaygroundSession => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  config: { ...DEFAULT_CONFIG },
  parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
  systemPrompt: '',
  openingMessage: '',
  suggestedQuestions: [],
  context: { ...DEFAULT_CONTEXT_SETTINGS },
  contextSummary: null,
  messages: [],
})

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.reset()
})

afterEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.reset()
})

test('loads only the current account session key and falls back to a valid active session', () => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'one', role: 1 })
  saveSessionsState({ activeSessionId: 'missing', sessions: [session('one')] })

  useAuthStore.getState().auth.setUser({ id: 2, username: 'two', role: 1 })
  const accountTwo = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })

  expect(accountTwo.sessions).toHaveLength(1)
  expect(accountTwo.sessions[0].id).not.toBe('one')
  expect(accountTwo.activeSessionId).toBe(accountTwo.sessions[0].id)

  useAuthStore.getState().auth.setUser({ id: 1, username: 'one', role: 1 })
  const accountOne = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(accountOne).toEqual({
    activeSessionId: 'one',
    sessions: [session('one')],
  })
})

test('rejects malformed or unsupported session envelopes without entering state', () => {
  useAuthStore.getState().auth.setUser({ id: 3, username: 'three', role: 1 })
  const key = `${STORAGE_KEYS.SESSIONS}:3`
  localStorage.setItem(key, JSON.stringify({ version: 99, data: {} }))

  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })

  const repaired = JSON.parse(localStorage.getItem(key) ?? '{}')
  expect(repaired.version).toBe(2)
  expect(loaded.sessions).toHaveLength(1)
  expect(loaded.activeSessionId).toBe(loaded.sessions[0].id)
})

test('bounds persisted sessions and message history', () => {
  useAuthStore.getState().auth.setUser({ id: 4, username: 'four', role: 1 })
  const sessions = Array.from({ length: 25 }, (_, index) => ({
    ...session(`session-${index}`),
    messages: Array.from({ length: 150 }, (_, messageIndex) => ({
      key: `message-${messageIndex}`,
      from: 'user' as const,
      versions: [{ id: `version-${messageIndex}`, content: 'message' }],
    })),
  }))

  saveSessionsState({ activeSessionId: 'session-24', sessions })
  const stored = localStorage.getItem(`${STORAGE_KEYS.SESSIONS}:4`)
  expect(stored).not.toBeNull()

  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(loaded.sessions).toHaveLength(20)
  expect(loaded.sessions.every((item) => item.messages.length <= 100)).toBe(
    true
  )
})

test('migrates a version one session envelope and rewrites it at the current version', () => {
  useAuthStore.getState().auth.setUser({ id: 5, username: 'five', role: 1 })
  const key = `${STORAGE_KEYS.SESSIONS}:5`
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      data: {
        activeSessionId: 'legacy',
        sessions: [
          {
            id: 'legacy',
            title: '  Legacy  ',
            createdAt: 1,
            updatedAt: 2,
            config: { model: 'legacy-model' },
            parameterEnabled: { temperature: false },
            messages: [],
          },
        ],
      },
    })
  )

  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })

  expect(loaded.sessions[0].title).toBe('Legacy')
  expect(loaded.sessions[0].config.model).toBe('legacy-model')
  expect(loaded.sessions[0].parameterEnabled.temperature).toBe(false)
  expect(loaded.sessions[0].systemPrompt).toBe('')
  expect(JSON.parse(localStorage.getItem(key) ?? '{}').version).toBe(2)
})

test('keeps a stored system prompt and defaults a session written before the field existed', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  saveSessionsState({
    activeSessionId: 'with-prompt',
    sessions: [
      { ...session('with-prompt'), systemPrompt: 'Answer in French.' },
    ],
  })

  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(loaded.sessions[0].systemPrompt).toBe('Answer in French.')

  // A snapshot serialized before the field existed loads with an empty prompt
  // instead of dropping the whole conversation.
  const key = `${STORAGE_KEYS.SESSIONS}:7`
  const stored = JSON.parse(localStorage.getItem(key) ?? '{}')
  delete stored.data.sessions[0].systemPrompt
  localStorage.setItem(key, JSON.stringify(stored))

  const legacy = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(legacy.sessions[0].systemPrompt).toBe('')
  expect(legacy.sessions[0].id).toBe('with-prompt')
})

test('reads user-scoped legacy data without deleting it before session migration', () => {
  useAuthStore.getState().auth.setUser({ id: 6, username: 'six', role: 1 })
  localStorage.setItem(
    `${STORAGE_KEYS.CONFIG}:6`,
    JSON.stringify({ version: 1, data: { model: 'legacy-model' } })
  )
  localStorage.setItem(
    `${STORAGE_KEYS.PARAMETER_ENABLED}:6`,
    JSON.stringify({ version: 1, data: { temperature: false } })
  )

  const legacy = loadLegacyPlaygroundState(6)

  expect(legacy.config).toEqual({ model: 'legacy-model' })
  expect(legacy.parameterEnabled).toEqual({ temperature: false })
  expect(localStorage.getItem(`${STORAGE_KEYS.CONFIG}:6`)).not.toBeNull()
})

test('server cache eviction keeps unsynced drafts even when older than cached history', () => {
  useAuthStore.getState().auth.setUser({ id: 10, username: 'ten', role: 1 })
  const sessions = Array.from({ length: 21 }, (_, i) => ({
    ...session(`remote-${i}`),
    server: { id: `pgs_${i}`, revision: 0, messageRevision: 0 },
    syncPending: false,
  }))
  sessions[20].syncPending = true
  saveSessionsState({ activeSessionId: 'remote-0', sessions })
  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(loaded.sessions.some((item) => item.id === 'remote-20')).toBe(true)
})

test('context settings and the compression node survive a storage round trip', () => {
  useAuthStore.getState().auth.setUser({ id: 11, username: 'eleven', role: 1 })
  saveSessionsState({
    activeSessionId: 'with-context',
    sessions: [
      {
        ...session('with-context'),
        context: {
          historyLimit: 12,
          tokenBudget: 3000,
          autoSummarize: true,
          summaryModel: 'summary-model',
        },
        contextSummary: {
          id: 'pgc_1',
          content: 'Earlier messages were compressed.',
          throughMessageKey: 'm1',
          messageCount: 3,
          model: 'summary-model',
          createdAt: 5,
          requestId: 'req-1',
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
        },
      },
    ],
  })

  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(loaded.sessions[0].context).toEqual({
    historyLimit: 12,
    tokenBudget: 3000,
    autoSummarize: true,
    summaryModel: 'summary-model',
  })
  expect(loaded.sessions[0].contextSummary).toMatchObject({
    id: 'pgc_1',
    throughMessageKey: 'm1',
    messageCount: 3,
    requestId: 'req-1',
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  })
})

test('missing or corrupt context data degrades to defaults without dropping the conversation', () => {
  useAuthStore.getState().auth.setUser({ id: 12, username: 'twelve', role: 1 })
  const legacySession = { ...session('legacy') } as Record<string, unknown>
  delete legacySession.context
  delete legacySession.contextSummary
  const corruptSession = {
    ...session('corrupt'),
    context: { historyLimit: -5, tokenBudget: 'many', autoSummarize: 'yes' },
    contextSummary: { id: 'pgc', content: '', throughMessageKey: 'x' },
  }
  localStorage.setItem(
    `${STORAGE_KEYS.SESSIONS}:12`,
    JSON.stringify({
      version: 2,
      data: {
        activeSessionId: 'legacy',
        sessions: [legacySession, corruptSession],
      },
    })
  )

  const loaded = loadSessionsState({
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    messages: [],
  })
  expect(loaded.sessions).toHaveLength(2)
  for (const item of loaded.sessions) {
    expect(item.context).toEqual(DEFAULT_CONTEXT_SETTINGS)
    expect(item.contextSummary).toBeNull()
  }
})
