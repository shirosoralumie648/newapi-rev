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
import { beforeEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { redemptionSchema, type Redemption } from '../../types'
import {
  getRedemptionFormSchema,
  REDEMPTION_FORM_DEFAULT_VALUES,
  transformFormDataToPayload,
  transformRedemptionToFormDefaults,
} from '../redemption-form'

const t = ((key: string, options?: Record<string, unknown>) => {
  if (options?.id !== undefined) {
    return key.replace('{{id}}', String(options.id))
  }
  return key
}) as TFunction

beforeEach(() => {
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

const subscriptionRedemption: Redemption = {
  id: 9,
  user_id: 1,
  name: 'sub-code',
  key: 'key-9',
  status: 1,
  quota: 0,
  type: 'subscription',
  plan_id: 7,
  duration_unit: 'month',
  duration_value: 3,
  duration_seconds: 0,
  created_time: 1,
  redeemed_time: 0,
  expired_time: 0,
  used_user_id: 0,
}

const legacyQuotaRedemption: Redemption = {
  id: 4,
  user_id: 1,
  name: 'legacy-code',
  key: 'key-4',
  status: 1,
  quota: 500001,
  type: 'quota',
  plan_id: 0,
  duration_unit: '',
  duration_value: 0,
  duration_seconds: 0,
  created_time: 1,
  redeemed_time: 0,
  expired_time: 0,
  used_user_id: 0,
}

describe('redemption form mapping', () => {
  test('keeps the legacy quota payload shape', () => {
    const payload = transformFormDataToPayload(REDEMPTION_FORM_DEFAULT_VALUES)

    expect(payload.type).toBe('quota')
    expect(payload.quota).toBe(5000000)
    expect(payload.plan_id).toBe(0)
    expect(payload.duration_unit).toBe('')
    expect(payload.duration_value).toBe(0)
    expect(payload.duration_seconds).toBe(0)
  })

  test('carries the plan and a duration override for subscription codes', () => {
    const payload = transformFormDataToPayload({
      ...REDEMPTION_FORM_DEFAULT_VALUES,
      type: 'subscription',
      plan_id: 7,
      quota_dollars: 25,
      duration_unit: 'month',
      duration_value: 3,
    })

    expect(payload.type).toBe('subscription')
    expect(payload.quota).toBe(0)
    expect(payload.plan_id).toBe(7)
    expect(payload.duration_unit).toBe('month')
    expect(payload.duration_value).toBe(3)
    expect(payload.duration_seconds).toBe(0)
  })

  test('uses seconds for a custom duration override', () => {
    const payload = transformFormDataToPayload({
      ...REDEMPTION_FORM_DEFAULT_VALUES,
      type: 'subscription',
      plan_id: 7,
      duration_unit: 'custom',
      duration_value: 99,
      duration_seconds: 7200,
    })

    expect(payload.duration_unit).toBe('custom')
    expect(payload.duration_value).toBe(0)
    expect(payload.duration_seconds).toBe(7200)
  })

  test('sends no override when the code uses the plan duration', () => {
    const payload = transformFormDataToPayload({
      ...REDEMPTION_FORM_DEFAULT_VALUES,
      type: 'subscription',
      plan_id: 7,
      duration_unit: '',
      duration_value: 5,
      duration_seconds: 600,
    })

    expect(payload.duration_unit).toBe('')
    expect(payload.duration_value).toBe(0)
    expect(payload.duration_seconds).toBe(0)
  })

  test('maps a subscription row back into the form', () => {
    const values = transformRedemptionToFormDefaults(subscriptionRedemption)

    expect(values.type).toBe('subscription')
    expect(values.plan_id).toBe(7)
    expect(values.duration_unit).toBe('month')
    expect(values.duration_value).toBe(3)
  })

  test('maps a quota row back into the form', () => {
    const values = transformRedemptionToFormDefaults(legacyQuotaRedemption)

    expect(values.type).toBe('quota')
    expect(values.plan_id).toBe(0)
    expect(values.duration_unit).toBe('')
  })

  test('treats legacy rows without a stored type as quota codes', () => {
    const parsed = redemptionSchema.parse({
      ...legacyQuotaRedemption,
      type: undefined,
      plan_id: undefined,
      duration_unit: undefined,
      duration_value: undefined,
      duration_seconds: undefined,
    })

    expect(parsed.type).toBe('quota')
    expect(parsed.plan_id).toBe(0)
    expect(transformRedemptionToFormDefaults(parsed).type).toBe('quota')
  })

  test('requires a plan for subscription codes', () => {
    const schema = getRedemptionFormSchema(t)
    const result = schema.safeParse({
      ...REDEMPTION_FORM_DEFAULT_VALUES,
      type: 'subscription',
      plan_id: 0,
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['plan_id'])
  })

  test('rejects an out-of-range duration override', () => {
    const schema = getRedemptionFormSchema(t)
    const result = schema.safeParse({
      ...REDEMPTION_FORM_DEFAULT_VALUES,
      type: 'subscription',
      plan_id: 7,
      duration_unit: 'year',
      duration_value: 11,
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(
      'Duration override cannot exceed 10 years'
    )
  })

  test('accepts a valid subscription code', () => {
    const schema = getRedemptionFormSchema(t)
    const result = schema.safeParse({
      ...REDEMPTION_FORM_DEFAULT_VALUES,
      type: 'subscription',
      plan_id: 7,
      duration_unit: 'day',
      duration_value: 3,
    })

    expect(result.success).toBe(true)
  })
})
