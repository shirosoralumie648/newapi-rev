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
import type { TFunction } from 'i18next'
import { describe, expect, test } from 'vitest'

import { apiKeySchema, type ApiKey } from '../../types'
import {
  getApiKeyFormDefaultValues,
  getApiKeyFormSchema,
  MAX_API_KEY_RPM,
  MAX_API_KEY_TPM,
  normalizeTokenRateLimit,
  transformApiKeyToFormDefaults,
  transformFormDataToPayload,
} from '../api-key-form'

const t = ((key: string, options?: Record<string, unknown>) => {
  if (options?.max !== undefined) {
    return key.replace('{{max}}', String(options.max))
  }
  return key
}) as TFunction

const baseApiKey: ApiKey = {
  id: 1,
  name: 'test',
  key: 'sk-test',
  status: 1,
  remain_quota: 0,
  used_quota: 0,
  unlimited_quota: true,
  expired_time: -1,
  created_time: 1,
  accessed_time: 0,
  group: 'auto',
  auto_groups: null,
  cross_group_retry: true,
  model_limits_enabled: false,
  model_limits: '',
  allow_ips: '',
  allow_user_quota_query: false,
  period_quota: 0,
  period_reset_period: '',
  period_used: 0,
  period_window_start: 0,
  rpm_limit: 0,
  tpm_limit: 0,
}

describe('API key Auto group form mapping', () => {
  test('treats legacy token responses without auto_groups as inheritance', () => {
    const legacyApiKey: Record<string, unknown> = { ...baseApiKey }
    delete legacyApiKey.auto_groups

    expect(apiKeySchema.parse(legacyApiKey).auto_groups).toBe(null)
  })

  test('creates an Auto token that inherits the global order', () => {
    const defaults = getApiKeyFormDefaultValues(true)

    expect(defaults.group).toBe('auto')
    expect(defaults.auto_groups_mode).toBe('inherit')
    expect(defaults.auto_groups).toEqual([])
    expect(transformFormDataToPayload(defaults).auto_groups).toEqual([])
  })

  test('maps omitted, null, and empty snapshots to inheritance on edit', () => {
    const legacyApiKey: Record<string, unknown> = { ...baseApiKey }
    delete legacyApiKey.auto_groups
    const inheritedApiKeys = [
      apiKeySchema.parse(legacyApiKey),
      baseApiKey,
      { ...baseApiKey, auto_groups: [] },
    ]

    for (const apiKey of inheritedApiKeys) {
      const defaults = transformApiKeyToFormDefaults(
        apiKey,
        ['default', 'vip'],
        2
      )

      expect(defaults.auto_groups_mode).toBe('inherit')
      expect(defaults.auto_groups).toEqual([])
    }
  })

  test('filters a stored snapshot before applying a lowered limit', () => {
    const defaults = transformApiKeyToFormDefaults(
      {
        ...baseApiKey,
        auto_groups: ['revoked', 'vip', 'default'],
      },
      ['default', 'vip'],
      2
    )

    expect(defaults.auto_groups_mode).toBe('custom')
    expect(defaults.auto_groups).toEqual(['vip', 'default'])
  })

  test('keeps a fully filtered snapshot custom and rejects it until resolved', () => {
    const defaults = transformApiKeyToFormDefaults(
      { ...baseApiKey, auto_groups: ['revoked'] },
      ['default'],
      2
    )

    expect(defaults.auto_groups_mode).toBe('custom')
    expect(defaults.auto_groups).toEqual([])

    const result = getApiKeyFormSchema(t, 2).safeParse(defaults)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.path).toEqual(['auto_groups'])
    expect(result.error.issues[0]?.message).toBe(
      'Select at least one Auto group or restore global Auto.'
    )
  })

  test('submits a valid custom snapshot in its configured order', () => {
    const custom = {
      ...getApiKeyFormDefaultValues(true),
      auto_groups_mode: 'custom' as const,
      auto_groups: ['vip', 'default'],
    }

    expect(transformFormDataToPayload(custom).auto_groups).toEqual([
      'vip',
      'default',
    ])
  })

  test('submits an empty array for inheritance and for non-Auto groups', () => {
    const inherited = getApiKeyFormDefaultValues(true)
    expect(transformFormDataToPayload(inherited).auto_groups).toEqual([])

    const nonAuto = {
      ...inherited,
      group: 'default',
      auto_groups_mode: 'custom' as const,
      auto_groups: ['vip'],
    }
    expect(transformFormDataToPayload(nonAuto).auto_groups).toEqual([])
    expect(transformFormDataToPayload(nonAuto).cross_group_retry).toBe(false)
  })

  test('rejects snapshots over the configured limit', () => {
    const result = getApiKeyFormSchema(t, 1).safeParse({
      ...getApiKeyFormDefaultValues(true),
      name: 'limited token',
      auto_groups_mode: 'custom',
      auto_groups: ['default', 'vip'],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.path[0]).toBe('auto_groups')
    expect(result.error.issues[0]?.message).toBe('Select at most 1 Auto groups')
  })

  test('rejects duplicate custom groups', () => {
    const result = getApiKeyFormSchema(t).safeParse({
      ...getApiKeyFormDefaultValues(true),
      name: 'duplicate token',
      auto_groups_mode: 'custom',
      auto_groups: ['vip', 'vip'],
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toBe(
      'Auto groups must not contain duplicates'
    )
  })
})

describe('API key user quota query form mapping', () => {
  test('lets a new key query the user quota by default', () => {
    for (const defaultUseAutoGroup of [true, false]) {
      const defaults = getApiKeyFormDefaultValues(defaultUseAutoGroup)

      expect(defaults.allow_user_quota_query).toBe(true)
      expect(transformFormDataToPayload(defaults).allow_user_quota_query).toBe(
        true
      )
    }
  })

  test.each([true, false])(
    'keeps the stored value %s when an existing key is edited and saved',
    (stored) => {
      const defaults = transformApiKeyToFormDefaults({
        ...baseApiKey,
        allow_user_quota_query: stored,
      })

      expect(defaults.allow_user_quota_query).toBe(stored)
      expect(transformFormDataToPayload(defaults).allow_user_quota_query).toBe(
        stored
      )
    }
  )
})

describe('API key periodic quota form mapping', () => {
  test('converts the displayed period amount into quota units on submit', () => {
    const payload = transformFormDataToPayload({
      ...getApiKeyFormDefaultValues(true),
      name: 'periodic token',
      period_reset_period: 'day',
      period_quota_dollars: 2.5,
    })

    expect(payload.period_reset_period).toBe('day')
    expect(payload.period_quota).toBe(1_250_000)
  })

  test('clears the period budget whenever no reset cycle is selected', () => {
    const payload = transformFormDataToPayload({
      ...getApiKeyFormDefaultValues(true),
      period_quota_dollars: 10,
    })

    expect(payload.period_reset_period).toBe('')
    expect(payload.period_quota).toBe(0)
  })

  test('requires a positive amount once a reset cycle is selected, even with unlimited quota', () => {
    const invalidAmounts = [undefined, 0, -1]

    for (const period_quota_dollars of invalidAmounts) {
      const result = getApiKeyFormSchema(t).safeParse({
        ...getApiKeyFormDefaultValues(true),
        name: 'periodic token',
        period_reset_period: 'week',
        period_quota_dollars,
      })

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues[0]?.path).toEqual(['period_quota_dollars'])
      expect(result.error.issues[0]?.message).toBe(
        'Periodic quota must be greater than zero'
      )
    }
  })

  test('accepts a period budget together with unlimited quota because the budget is independent', () => {
    const defaults = getApiKeyFormDefaultValues(true)
    const result = getApiKeyFormSchema(t).safeParse({
      ...defaults,
      name: 'unlimited with budget',
      period_reset_period: 'month',
      period_quota_dollars: 5,
    })

    expect(defaults.unlimited_quota).toBe(true)
    expect(result.success).toBe(true)
  })

  test('round-trips a stored period budget into the edit form', () => {
    const defaults = transformApiKeyToFormDefaults({
      ...baseApiKey,
      period_quota: 1_000_000,
      period_reset_period: 'week',
      period_used: 250_000,
    })

    expect(defaults.period_reset_period).toBe('week')
    expect(defaults.period_quota_dollars).toBe(2)

    const payload = transformFormDataToPayload(defaults)
    expect(payload.period_reset_period).toBe('week')
    expect(payload.period_quota).toBe(1_000_000)
  })

  test('drops an unrecognized stored reset cycle instead of sending it back', () => {
    const defaults = transformApiKeyToFormDefaults({
      ...baseApiKey,
      period_quota: 1_000_000,
      period_reset_period: 'hourly',
    })

    expect(defaults.period_reset_period).toBe('')
    expect(transformFormDataToPayload(defaults).period_quota).toBe(0)
  })
})

describe('API key rate limit form mapping', () => {
  test('defaults a new key to unlimited requests and tokens', () => {
    const defaults = getApiKeyFormDefaultValues(true)

    expect(defaults.rpm_limit).toBe(0)
    expect(defaults.tpm_limit).toBe(0)

    const payload = transformFormDataToPayload(defaults)
    expect(payload.rpm_limit).toBe(0)
    expect(payload.tpm_limit).toBe(0)
  })

  test('round-trips stored limits into the edit form and payload', () => {
    const defaults = transformApiKeyToFormDefaults({
      ...baseApiKey,
      rpm_limit: 60,
      tpm_limit: 9000,
    })

    expect(defaults.rpm_limit).toBe(60)
    expect(defaults.tpm_limit).toBe(9000)

    const payload = transformFormDataToPayload(defaults)
    expect(payload.rpm_limit).toBe(60)
    expect(payload.tpm_limit).toBe(9000)
  })

  test('normalizes an out-of-range stored limit instead of rejecting the edit form', () => {
    const defaults = transformApiKeyToFormDefaults({
      ...baseApiKey,
      rpm_limit: MAX_API_KEY_RPM + 10,
      tpm_limit: -1,
    })

    expect(defaults.rpm_limit).toBe(MAX_API_KEY_RPM)
    expect(defaults.tpm_limit).toBe(0)
  })

  test.each([
    { field: 'rpm_limit', value: MAX_API_KEY_RPM + 1 },
    { field: 'tpm_limit', value: MAX_API_KEY_TPM + 1 },
  ])(
    'rejects a $field above the backend bound before saving',
    ({ field, value }) => {
      const result = getApiKeyFormSchema(t).safeParse({
        ...getApiKeyFormDefaultValues(true),
        name: 'rate limited token',
        [field]: value,
      })

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(
        true
      )
    }
  )

  test('normalizeTokenRateLimit clamps to whole values inside the bound', () => {
    expect(normalizeTokenRateLimit(undefined, MAX_API_KEY_RPM)).toBe(0)
    expect(normalizeTokenRateLimit(Number.NaN, MAX_API_KEY_RPM)).toBe(0)
    expect(normalizeTokenRateLimit(12.9, MAX_API_KEY_RPM)).toBe(12)
    expect(normalizeTokenRateLimit(-1, MAX_API_KEY_RPM)).toBe(0)
    expect(normalizeTokenRateLimit(MAX_API_KEY_RPM + 1, MAX_API_KEY_RPM)).toBe(
      MAX_API_KEY_RPM
    )
  })
})
