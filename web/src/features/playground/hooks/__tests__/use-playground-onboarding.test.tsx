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
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test } from 'vitest'

import { STORAGE_KEYS } from '../../constants'
import { usePlaygroundOnboarding } from '../use-playground-onboarding'

function seedUser(
  userId: number,
  welcomeSeen: boolean,
  tourCompleted: boolean
) {
  window.localStorage.setItem(
    `${STORAGE_KEYS.ONBOARDING}:${userId}`,
    JSON.stringify({
      version: 1,
      data: { welcomeSeen, tourCompleted },
    })
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

test('a first visit opens the welcome card for that account', async () => {
  const { result } = renderHook(() => usePlaygroundOnboarding(7))

  await waitFor(() => expect(result.current.welcomeOpen).toBe(true))
  expect(result.current.isNewcomer).toBe(true)
})

test('dismissing the welcome card records it and does not open it again', async () => {
  const first = renderHook(() => usePlaygroundOnboarding(7))
  await waitFor(() => expect(first.result.current.welcomeOpen).toBe(true))

  act(() => first.result.current.dismissWelcome())

  expect(first.result.current.welcomeOpen).toBe(false)
  expect(first.result.current.isNewcomer).toBe(true)
  expect(window.localStorage.getItem(`${STORAGE_KEYS.ONBOARDING}:7`)).toContain(
    '"welcomeSeen":true'
  )

  first.unmount()
  const second = renderHook(() => usePlaygroundOnboarding(7))
  await waitFor(() => expect(second.result.current.isNewcomer).toBe(true))
  expect(second.result.current.welcomeOpen).toBe(false)
})

test('Help replays the card for a returning account', async () => {
  seedUser(7, true, true)
  const { result } = renderHook(() => usePlaygroundOnboarding(7))

  await waitFor(() => expect(result.current.isNewcomer).toBe(false))
  expect(result.current.welcomeOpen).toBe(false)

  act(() => result.current.replayWelcome())
  expect(result.current.welcomeOpen).toBe(true)
})

test('finishing the tour leaves the newcomer stage and persists completion', async () => {
  seedUser(7, true, false)
  const { result } = renderHook(() => usePlaygroundOnboarding(7))
  await waitFor(() => expect(result.current.isNewcomer).toBe(true))

  act(() => result.current.completeTour())

  expect(result.current.isNewcomer).toBe(false)
  expect(window.localStorage.getItem(`${STORAGE_KEYS.ONBOARDING}:7`)).toContain(
    '"tourCompleted":true'
  )
})

test('switching accounts reads the new account record before opening the card', async () => {
  seedUser(8, true, false)
  const { result, rerender } = renderHook(
    ({ userId }: { userId: number }) => usePlaygroundOnboarding(userId),
    { initialProps: { userId: 7 } }
  )
  await waitFor(() => expect(result.current.welcomeOpen).toBe(true))

  rerender({ userId: 8 })

  await waitFor(() => expect(result.current.welcomeOpen).toBe(false))
  expect(result.current.isNewcomer).toBe(true)
})
