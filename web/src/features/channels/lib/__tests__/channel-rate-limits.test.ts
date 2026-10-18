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
  MAX_CHANNEL_CONCURRENCY,
  MAX_RATE_LIMIT_RPM,
  MAX_RATE_LIMIT_TPM,
  normalizeAdmissionLimit,
  transformChannelToFormDefaults,
  transformFormDataToCreatePayload,
  transformFormDataToUpdatePayload,
} from '../channel-form'

function channelWithAdmissionSetting(
  setting: Record<string, unknown>
): Channel {
  return channelSchema.parse({
    id: 1,
    name: 'Admission limit channel',
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

describe('channel admission limit settings', () => {
  test.each([
    { maxConcurrency: 0, rpm: 0, tpm: 0 },
    { maxConcurrency: 1, rpm: 60, tpm: 1000000 },
    {
      maxConcurrency: MAX_CHANNEL_CONCURRENCY,
      rpm: MAX_RATE_LIMIT_RPM,
      tpm: MAX_RATE_LIMIT_TPM,
    },
  ])(
    'preserves concurrency $maxConcurrency, rpm $rpm and tpm $tpm through create, update and reload',
    ({ maxConcurrency, rpm, tpm }) => {
      const channel = channelWithAdmissionSetting({
        max_concurrency: maxConcurrency,
        rpm_limit: rpm,
        tpm_limit: tpm,
      })
      const values = transformChannelToFormDefaults(channel)
      expect(values.max_concurrency).toBe(maxConcurrency)
      expect(values.rpm_limit).toBe(rpm)
      expect(values.tpm_limit).toBe(tpm)

      const payloads = [
        transformFormDataToCreatePayload(values).channel,
        transformFormDataToUpdatePayload(values, channel.id),
      ]
      for (const payload of payloads) {
        expect(typeof payload.setting).toBe('string')
        const setting = JSON.parse(payload.setting as string)
        const persisted: Array<[string, number]> = [
          ['max_concurrency', maxConcurrency],
          ['rpm_limit', rpm],
          ['tpm_limit', tpm],
        ]
        for (const [key, value] of persisted) {
          if (value === 0) {
            // Zero means unlimited; it must not be persisted so a channel
            // without an explicit limit stays explicit.
            expect(setting).not.toHaveProperty(key)
          } else {
            expect(setting[key]).toBe(value)
          }
        }
        const reloaded = transformChannelToFormDefaults({
          ...channel,
          setting: payload.setting as string,
        })
        expect(reloaded.max_concurrency).toBe(maxConcurrency)
        expect(reloaded.rpm_limit).toBe(rpm)
        expect(reloaded.tpm_limit).toBe(tpm)
      }
    }
  )

  test('new channels default to unlimited', () => {
    expect(CHANNEL_FORM_DEFAULT_VALUES.max_concurrency).toBe(0)
    expect(CHANNEL_FORM_DEFAULT_VALUES.rpm_limit).toBe(0)
    expect(CHANNEL_FORM_DEFAULT_VALUES.tpm_limit).toBe(0)
    const setting = buildSettingJSON(CHANNEL_FORM_DEFAULT_VALUES)
    expect(setting).not.toContain('max_concurrency')
    expect(setting).not.toContain('rpm_limit')
    expect(setting).not.toContain('tpm_limit')
  })

  test.each([
    { stored: 1.5, expected: 1 },
    { stored: -5, expected: 0 },
    { stored: MAX_CHANNEL_CONCURRENCY + 10, expected: MAX_CHANNEL_CONCURRENCY },
    { stored: 'oops', expected: 0 },
    { stored: undefined, expected: 0 },
  ])(
    'normalizes a stored concurrency of $stored to $expected',
    ({ stored, expected }) => {
      const channel = channelWithAdmissionSetting({ max_concurrency: stored })
      expect(transformChannelToFormDefaults(channel).max_concurrency).toBe(
        expected
      )
    }
  )

  test.each([
    { key: 'rpm_limit', value: MAX_RATE_LIMIT_RPM + 1 },
    { key: 'tpm_limit', value: MAX_RATE_LIMIT_TPM + 1 },
    { key: 'max_concurrency', value: MAX_CHANNEL_CONCURRENCY + 1 },
  ])(
    'rejects a $key above the backend bound before saving',
    ({ key, value }) => {
      const result = channelFormSchema.safeParse({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        name: 'Channel',
        models: 'gpt-4o',
        key: 'sk-test',
        [key]: value,
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path[0] === key)).toBe(
          true
        )
      }
    }
  )

  test('a configured admission limit marks the extra settings block as configured', () => {
    const configured = getChannelConfigurationState(
      { ...CHANNEL_FORM_DEFAULT_VALUES, rpm_limit: 60 },
      {},
      true
    )
    expect(configured.blocks.extraSettings).toBe('configured')

    const unconfigured = getChannelConfigurationState(
      {
        ...CHANNEL_FORM_DEFAULT_VALUES,
        max_concurrency: 0,
        rpm_limit: 0,
        tpm_limit: 0,
      },
      {},
      true
    )
    expect(unconfigured.blocks.extraSettings).toBe('idle')
  })

  test('normalizeAdmissionLimit clamps to whole values inside the bound', () => {
    expect(normalizeAdmissionLimit(undefined, MAX_RATE_LIMIT_RPM)).toBe(0)
    expect(normalizeAdmissionLimit(Number.NaN, MAX_RATE_LIMIT_RPM)).toBe(0)
    expect(normalizeAdmissionLimit(12.9, MAX_RATE_LIMIT_RPM)).toBe(12)
    expect(normalizeAdmissionLimit(-1, MAX_RATE_LIMIT_RPM)).toBe(0)
    expect(
      normalizeAdmissionLimit(MAX_RATE_LIMIT_RPM + 1, MAX_RATE_LIMIT_RPM)
    ).toBe(MAX_RATE_LIMIT_RPM)
  })
})
