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
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import {
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  STORAGE_KEYS,
} from '../../constants'
import { usePlaygroundState } from '../use-playground-state'

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  useAuthStore.getState().auth.reset()
})

test('creates, switches, renames, and deletes isolated sessions', async () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  const hook = renderHook(() => usePlaygroundState())
  expect(hook.result.current.sessions).toHaveLength(1)

  const firstId = hook.result.current.activeSessionId
  act(() => hook.result.current.updateConfig('model', 'first-model'))
  act(() => hook.result.current.createSession())
  const secondId = hook.result.current.activeSessionId

  expect(secondId).not.toBe(firstId)
  expect(hook.result.current.config.model).toBe('first-model')

  act(() => hook.result.current.renameSession(secondId ?? '', '  Second  '))
  act(() => hook.result.current.switchSession(firstId ?? ''))
  expect(hook.result.current.config.model).toBe('first-model')
  expect(
    hook.result.current.sessions.find((s) => s.id === secondId)?.title
  ).toBe('Second')

  act(() => hook.result.current.deleteSession(firstId ?? ''))
  expect(hook.result.current.activeSessionId).toBe(secondId)
})

test('deleting the last session keeps a default-config fallback', async () => {
  useAuthStore.getState().auth.setUser({ id: 8, username: 'eight', role: 1 })
  const hook = renderHook(() => usePlaygroundState())
  expect(hook.result.current.sessions).toHaveLength(1)
  const onlyId = hook.result.current.activeSessionId

  act(() => hook.result.current.updateParameterEnabled('temperature', false))
  act(() => hook.result.current.deleteSession(onlyId ?? ''))

  expect(hook.result.current.sessions).toHaveLength(1)
  expect(hook.result.current.activeSessionId).not.toBe(onlyId)
  expect(hook.result.current.config).toEqual(DEFAULT_CONFIG)
  expect(hook.result.current.parameterEnabled).toEqual({
    ...DEFAULT_PARAMETER_ENABLED,
    temperature: false,
  })
})

test('persists active session updates without writing legacy config keys', () => {
  useAuthStore.getState().auth.setUser({ id: 9, username: 'nine', role: 1 })
  const hook = renderHook(() => usePlaygroundState())

  act(() => hook.result.current.updateConfig('model', 'session-model'))
  act(() => vi.advanceTimersByTime(600))

  expect(localStorage.getItem(`${STORAGE_KEYS.CONFIG}:9`)).toBeNull()
  expect(localStorage.getItem(`${STORAGE_KEYS.SESSIONS}:9`)).not.toBeNull()
})

test('catalog defaults seed only a new conversation and presets win', () => {
  useAuthStore.getState().auth.setUser({ id: 11, username: 'eleven', role: 1 })
  const hook = renderHook(() => usePlaygroundState())

  act(() =>
    hook.result.current.createSession({
      model: 'catalog-model',
      modelDefaults: {
        temperature: 0,
        topP: 0.5,
        maxTokens: 2048,
        seed: 42,
      },
    })
  )
  const catalogSessionId = hook.result.current.activeSessionId
  expect(hook.result.current.config).toMatchObject({
    model: 'catalog-model',
    temperature: 0,
    top_p: 0.5,
    max_tokens: 2048,
    seed: 42,
  })
  expect(hook.result.current.parameterEnabled).toMatchObject({
    temperature: true,
    top_p: true,
    max_tokens: true,
    seed: true,
  })

  // Changing the model in another conversation never rewrites the catalog
  // conversation that already stored its values.
  act(() => hook.result.current.createSession({ model: 'other-model' }))
  act(() => hook.result.current.updateConfig('model', 'other-model'))
  act(() => hook.result.current.switchSession(catalogSessionId ?? ''))
  expect(hook.result.current.config).toMatchObject({
    model: 'catalog-model',
    temperature: 0,
    max_tokens: 2048,
  })

  // A preset states its own sampling values, so an attached catalog default
  // must not replace them.
  act(() =>
    hook.result.current.createSession({
      config: { ...DEFAULT_CONFIG, model: 'preset-model', temperature: 1.1 },
      modelDefaults: { temperature: 0 },
    })
  )
  expect(hook.result.current.config).toMatchObject({
    model: 'preset-model',
    temperature: 1.1,
  })
})

test('a new conversation starts from the account new-session defaults', () => {
  useAuthStore.getState().auth.setUser({ id: 10, username: 'ten', role: 1 })
  const first = renderHook(() => usePlaygroundState())

  act(() => {
    first.result.current.updateConfig('model', 'remembered-model')
    first.result.current.updateConfig('temperature', 0.2)
  })
  act(() => first.result.current.updateSystemPrompt('Remembered prompt'))
  act(() => first.result.current.updateParameterEnabled('temperature', false))
  act(() => vi.advanceTimersByTime(1000))
  first.unmount()

  // Drop the stored conversations but keep the account-level defaults, so the
  // fresh mount can only restore them from the preference store.
  localStorage.removeItem(`${STORAGE_KEYS.SESSIONS}:10`)

  const second = renderHook(() => usePlaygroundState())
  expect(second.result.current.config.model).toBe('remembered-model')
  expect(second.result.current.systemPrompt).toBe('Remembered prompt')
  expect(second.result.current.parameterEnabled.temperature).toBe(false)

  act(() => second.result.current.createSession())
  expect(second.result.current.config).toMatchObject({
    model: 'remembered-model',
    temperature: 0.2,
  })
  expect(second.result.current.systemPrompt).toBe('Remembered prompt')
  expect(second.result.current.parameterEnabled.temperature).toBe(false)
})
