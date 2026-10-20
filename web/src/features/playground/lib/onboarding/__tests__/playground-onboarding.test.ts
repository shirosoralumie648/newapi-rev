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
import { beforeEach, expect, test } from 'vitest'

import { STORAGE_KEYS } from '../../../constants'
import {
  loadPlaygroundOnboardingState,
  markPlaygroundTourCompleted,
  savePlaygroundOnboardingState,
} from '../playground-onboarding'

const key = `${STORAGE_KEYS.ONBOARDING}:7`

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

test('an account without a stored record starts at the first-visit state', () => {
  expect(loadPlaygroundOnboardingState(7)).toEqual({
    welcomeSeen: false,
    tourCompleted: false,
  })
  expect(loadPlaygroundOnboardingState(null)).toEqual({
    welcomeSeen: false,
    tourCompleted: false,
  })
})

test('the welcome read marker is stored per account and survives a reload', () => {
  expect(
    savePlaygroundOnboardingState(7, {
      welcomeSeen: true,
      tourCompleted: false,
    })
  ).toBe(true)

  expect(loadPlaygroundOnboardingState(7)).toEqual({
    welcomeSeen: true,
    tourCompleted: false,
  })
  expect(loadPlaygroundOnboardingState(8).welcomeSeen).toBe(false)
  expect(JSON.parse(window.localStorage.getItem(key) ?? '{}')).toMatchObject({
    version: 1,
    data: { welcomeSeen: true, tourCompleted: false },
  })
})

test('a damaged or outdated record falls back to the first-visit state', () => {
  window.localStorage.setItem(key, '{not json')
  expect(loadPlaygroundOnboardingState(7).welcomeSeen).toBe(false)

  window.localStorage.setItem(
    key,
    JSON.stringify({
      version: 2,
      data: { welcomeSeen: true, tourCompleted: true },
    })
  )
  expect(loadPlaygroundOnboardingState(7)).toEqual({
    welcomeSeen: false,
    tourCompleted: false,
  })

  window.localStorage.setItem(
    key,
    JSON.stringify({ version: 1, data: { welcomeSeen: 'yes' } })
  )
  expect(loadPlaygroundOnboardingState(7).welcomeSeen).toBe(false)
})

test('completing the tour also records that the welcome card was read', () => {
  markPlaygroundTourCompleted(7)

  expect(loadPlaygroundOnboardingState(7)).toEqual({
    welcomeSeen: true,
    tourCompleted: true,
  })
})
