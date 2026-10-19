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

import {
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  PLAYGROUND_NEW_SESSION_PROMPT_MAX_BYTES,
  STORAGE_KEYS,
} from '../../../constants'
import {
  loadAutoReadPreferences,
  loadAutoTitlePreferences,
  loadMCPPreferences,
  loadNewSessionDefaults,
  loadToolExecutionPreferences,
  saveAutoReadPreferences,
  saveAutoTitlePreferences,
  saveMCPPreferences,
  saveNewSessionDefaults,
  saveToolExecutionPreferences,
} from '../playground-preferences'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

test('remembers the new-conversation settings per account', () => {
  const saved = saveNewSessionDefaults(7, {
    config: { ...DEFAULT_CONFIG, model: 'recent-model', temperature: 0.2 },
    parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED, temperature: false },
    systemPrompt: 'Stay concise.',
  })

  expect(saved).toBe(true)
  expect(loadNewSessionDefaults(7)).toMatchObject({
    config: { model: 'recent-model', temperature: 0.2 },
    parameterEnabled: { temperature: false },
    systemPrompt: 'Stay concise.',
  })
  // Another account never sees the first account's defaults.
  expect(loadNewSessionDefaults(8)).toBeNull()
})

test('oversized or corrupted defaults degrade to none', () => {
  expect(
    saveNewSessionDefaults(7, {
      config: DEFAULT_CONFIG,
      parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      systemPrompt: 'x'.repeat(PLAYGROUND_NEW_SESSION_PROMPT_MAX_BYTES + 1),
    })
  ).toBe(false)
  expect(loadNewSessionDefaults(7)).toBeNull()

  localStorage.setItem(
    `${STORAGE_KEYS.NEW_SESSION_DEFAULTS}:9`,
    '{"version":1,"data":{"config":"broken"}}'
  )
  expect(loadNewSessionDefaults(9)).toBeNull()
})

test('stores the account default and per-conversation read-aloud overrides', () => {
  saveAutoReadPreferences(7, {
    defaultEnabled: true,
    overrides: { 'local-1': false },
  })

  expect(loadAutoReadPreferences(7)).toEqual({
    defaultEnabled: true,
    overrides: { 'local-1': false },
  })
  expect(loadAutoReadPreferences(8)).toEqual({
    defaultEnabled: false,
    overrides: {},
  })
})

test('malformed read-aloud overrides are dropped instead of breaking the store', () => {
  localStorage.setItem(
    `${STORAGE_KEYS.AUTO_READ_ALOUD}:7`,
    JSON.stringify({
      version: 1,
      data: {
        defaultEnabled: true,
        overrides: { keep: false, drop: 'yes', '': true },
      },
    })
  )

  expect(loadAutoReadPreferences(7)).toEqual({
    defaultEnabled: true,
    overrides: { keep: false },
  })
})

test('automatic naming is on by default and keeps per-conversation overrides', () => {
  expect(loadAutoTitlePreferences(7)).toEqual({
    defaultEnabled: true,
    overrides: {},
  })

  saveAutoTitlePreferences(7, {
    defaultEnabled: false,
    overrides: { 'local-1': true },
  })
  expect(loadAutoTitlePreferences(7)).toEqual({
    defaultEnabled: false,
    overrides: { 'local-1': true },
  })
  expect(loadAutoTitlePreferences(8)).toEqual({
    defaultEnabled: true,
    overrides: {},
  })
})

test('malformed naming overrides are dropped instead of breaking the store', () => {
  localStorage.setItem(
    `${STORAGE_KEYS.AUTO_TITLE}:7`,
    JSON.stringify({
      version: 1,
      data: {
        defaultEnabled: false,
        overrides: { keep: true, drop: 'yes', '': false },
      },
    })
  )

  expect(loadAutoTitlePreferences(7)).toEqual({
    defaultEnabled: false,
    overrides: { keep: true },
  })
})

test('the tool loop is off by default and the round cap stays within bounds', () => {
  expect(loadToolExecutionPreferences(7)).toEqual({
    enabled: false,
    maxRounds: 5,
  })

  saveToolExecutionPreferences(7, { enabled: true, maxRounds: 99 })
  expect(loadToolExecutionPreferences(7)).toEqual({
    enabled: true,
    maxRounds: 10,
  })

  saveToolExecutionPreferences(7, { enabled: true, maxRounds: 0 })
  expect(loadToolExecutionPreferences(7)).toEqual({
    enabled: true,
    maxRounds: 1,
  })
  // Another account never sees the first account's choice.
  expect(loadToolExecutionPreferences(8)).toEqual({
    enabled: false,
    maxRounds: 5,
  })
})

test('a malformed tool loop preference degrades to the default', () => {
  localStorage.setItem(
    `${STORAGE_KEYS.TOOL_EXECUTION}:7`,
    JSON.stringify({
      version: 1,
      data: { enabled: 'yes', maxRounds: 3 },
    })
  )
  expect(loadToolExecutionPreferences(7)).toEqual({
    enabled: false,
    maxRounds: 5,
  })

  localStorage.setItem(
    `${STORAGE_KEYS.TOOL_EXECUTION}:8`,
    JSON.stringify({
      version: 1,
      data: { enabled: true, maxRounds: 2.5 },
    })
  )
  expect(loadToolExecutionPreferences(8)).toEqual({
    enabled: false,
    maxRounds: 5,
  })
})

test('the MCP switch is off by default and remembered per account', () => {
  expect(loadMCPPreferences(7)).toEqual({ enabled: false })

  expect(saveMCPPreferences(7, { enabled: true })).toBe(true)
  expect(loadMCPPreferences(7)).toEqual({ enabled: true })
  // Another account never sees the first account's choice.
  expect(loadMCPPreferences(8)).toEqual({ enabled: false })
})

test('a malformed MCP preference degrades to the disabled default', () => {
  localStorage.setItem(
    `${STORAGE_KEYS.MCP}:7`,
    JSON.stringify({ version: 1, data: { enabled: 'yes' } })
  )

  expect(loadMCPPreferences(7)).toEqual({ enabled: false })
})
