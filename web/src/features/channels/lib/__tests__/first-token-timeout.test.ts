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
import { describe, expect, test } from 'vitest'

import { channelSchema, type Channel } from '../../types'
import { getChannelConfigurationState } from '../channel-configuration'
import {
  buildSettingJSON,
  channelFormSchema,
  CHANNEL_FORM_DEFAULT_VALUES,
  MAX_FIRST_TOKEN_TIMEOUT_SECONDS,
  normalizeFirstTokenTimeout,
  transformChannelToFormDefaults,
  transformFormDataToCreatePayload,
  transformFormDataToUpdatePayload,
} from '../channel-form'

function channelWithSetting(setting: Record<string, unknown>): Channel {
  return channelSchema.parse({
    id: 1,
    name: 'First token channel',
    key: '',
    type: 1,
    status: 1,
    created_time: 0,
    test_time: 0,
    response_time: 0,
    balance_updated_time: 0,
    setting: JSON.stringify(setting),
  })
}

describe('first_token_timeout channel setting', () => {
  test.each([0, 1, 30, MAX_FIRST_TOKEN_TIMEOUT_SECONDS])(
    'preserves %s seconds through create, update and reload',
    (timeout) => {
      const channel = channelWithSetting({ first_token_timeout: timeout })
      const values = transformChannelToFormDefaults(channel)
      expect(values.first_token_timeout).toBe(timeout)

      const payloads = [
        transformFormDataToCreatePayload(values).channel,
        transformFormDataToUpdatePayload(values, channel.id),
      ]
      for (const payload of payloads) {
        expect(typeof payload.setting).toBe('string')
        const setting = JSON.parse(payload.setting as string)
        if (timeout === 0) {
          // Zero means "use the global default"; it must not be persisted so a
          // channel without an explicit window stays explicit.
          expect(setting).not.toHaveProperty('first_token_timeout')
        } else {
          expect(setting.first_token_timeout).toBe(timeout)
        }
        expect(
          transformChannelToFormDefaults({
            ...channel,
            setting: payload.setting as string,
          }).first_token_timeout
        ).toBe(timeout)
      }
    }
  )

  test('new channels default to the global window', () => {
    expect(CHANNEL_FORM_DEFAULT_VALUES.first_token_timeout).toBe(0)
    expect(buildSettingJSON(CHANNEL_FORM_DEFAULT_VALUES)).not.toContain(
      'first_token_timeout'
    )
  })

  test.each([
    { stored: 1.5, expected: 1 },
    { stored: -5, expected: 0 },
    {
      stored: MAX_FIRST_TOKEN_TIMEOUT_SECONDS + 60,
      expected: MAX_FIRST_TOKEN_TIMEOUT_SECONDS,
    },
    { stored: 'oops', expected: 0 },
    { stored: undefined, expected: 0 },
  ])(
    'normalizes a stored value of $stored to $expected',
    ({ stored, expected }) => {
      const channel = channelWithSetting({ first_token_timeout: stored })
      expect(transformChannelToFormDefaults(channel).first_token_timeout).toBe(
        expected
      )
    }
  )

  test('rejects a window above the backend bound before saving', () => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'Channel',
      models: 'gpt-4o',
      key: 'sk-test',
      first_token_timeout: MAX_FIRST_TOKEN_TIMEOUT_SECONDS + 1,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path[0] === 'first_token_timeout'
        )
      ).toBe(true)
    }
  })

  test('a channel window marks the extra settings block as configured', () => {
    const configured = getChannelConfigurationState(
      { ...CHANNEL_FORM_DEFAULT_VALUES, first_token_timeout: 15 },
      {},
      true
    )
    expect(configured.blocks.extraSettings).toBe('configured')

    const unconfigured = getChannelConfigurationState(
      { ...CHANNEL_FORM_DEFAULT_VALUES, first_token_timeout: 0 },
      {},
      true
    )
    expect(unconfigured.blocks.extraSettings).toBe('idle')
  })

  test('normalizeFirstTokenTimeout clamps to whole seconds inside the bound', () => {
    expect(normalizeFirstTokenTimeout(undefined)).toBe(0)
    expect(normalizeFirstTokenTimeout(Number.NaN)).toBe(0)
    expect(normalizeFirstTokenTimeout(12.9)).toBe(12)
    expect(normalizeFirstTokenTimeout(-1)).toBe(0)
    expect(
      normalizeFirstTokenTimeout(MAX_FIRST_TOKEN_TIMEOUT_SECONDS + 1)
    ).toBe(MAX_FIRST_TOKEN_TIMEOUT_SECONDS)
  })
})
