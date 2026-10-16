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
