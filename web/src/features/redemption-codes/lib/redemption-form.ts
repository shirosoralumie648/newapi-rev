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
import { z } from 'zod'

import { parseQuotaFromDollars, quotaUnitsToEditableAmount } from '@/lib/format'

import {
  REDEMPTION_DURATION_MAX_SECONDS,
  REDEMPTION_DURATION_MAX_VALUE,
  REDEMPTION_VALIDATION,
  getRedemptionFormErrorMessages,
} from '../constants'
import {
  REDEMPTION_TYPE_QUOTA,
  REDEMPTION_TYPE_SUBSCRIPTION,
  redemptionTypeOf,
  type RedemptionFormData,
  type Redemption,
  type RedemptionType,
} from '../types'

// ============================================================================
// Form Schema (use getRedemptionFormSchema(t) in components for i18n messages)
// ============================================================================

export function getRedemptionFormSchema(t: TFunction) {
  const msg = getRedemptionFormErrorMessages(t)
  return z
    .object({
      name: z
        .string()
        .min(REDEMPTION_VALIDATION.NAME_MIN_LENGTH, msg.NAME_LENGTH_INVALID)
        .max(REDEMPTION_VALIDATION.NAME_MAX_LENGTH, msg.NAME_LENGTH_INVALID),
      type: z.enum(['quota', 'subscription']),
      quota_dollars: z.number().min(0, t('Quota must be a positive number')),
      plan_id: z.number(),
      duration_unit: z.enum(['', 'year', 'month', 'day', 'hour', 'custom']),
      duration_value: z.number(),
      duration_seconds: z.number(),
      expired_time: z.date().optional(),
      count: z
        .number()
        .min(REDEMPTION_VALIDATION.COUNT_MIN, msg.COUNT_INVALID)
        .max(REDEMPTION_VALIDATION.COUNT_MAX, msg.COUNT_INVALID)
        .optional(),
    })
    .superRefine((values, ctx) => {
      if (values.type !== REDEMPTION_TYPE_SUBSCRIPTION) {
        return
      }
      if (values.plan_id < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['plan_id'],
          message: msg.PLAN_REQUIRED,
        })
      }
      if (values.duration_unit === '') {
        return
      }
      if (values.duration_unit === 'custom') {
        if (
          values.duration_seconds < 1 ||
          values.duration_seconds > REDEMPTION_DURATION_MAX_SECONDS
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['duration_seconds'],
            message:
              values.duration_seconds > REDEMPTION_DURATION_MAX_SECONDS
                ? msg.DURATION_TOO_LONG
                : msg.DURATION_INVALID,
          })
        }
        return
      }
      const maxValue = REDEMPTION_DURATION_MAX_VALUE[values.duration_unit] ?? 0
      if (values.duration_value < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['duration_value'],
          message: msg.DURATION_INVALID,
        })
        return
      }
      if (values.duration_value > maxValue) {
        ctx.addIssue({
          code: 'custom',
          path: ['duration_value'],
          message: msg.DURATION_TOO_LONG,
        })
      }
    })
}

export type RedemptionFormValues = {
  name: string
  type: RedemptionType
  quota_dollars: number
  plan_id: number
  duration_unit: '' | 'year' | 'month' | 'day' | 'hour' | 'custom'
  duration_value: number
  duration_seconds: number
  expired_time?: Date
  count?: number
}

// ============================================================================
// Form Defaults
// ============================================================================

export const REDEMPTION_FORM_DEFAULT_VALUES: RedemptionFormValues = {
  name: '',
  type: REDEMPTION_TYPE_QUOTA,
  quota_dollars: 10,
  plan_id: 0,
  duration_unit: '',
  duration_value: 1,
  duration_seconds: 3600,
  expired_time: undefined,
  count: 1,
}

// ============================================================================
// Form Data Transformation
// ============================================================================

/**
 * Transform form data to API payload
 */
export function transformFormDataToPayload(
  data: RedemptionFormValues
): RedemptionFormData {
  if (data.type === REDEMPTION_TYPE_SUBSCRIPTION) {
    return {
      name: data.name,
      type: REDEMPTION_TYPE_SUBSCRIPTION,
      quota: 0,
      plan_id: data.plan_id,
      duration_unit: data.duration_unit,
      duration_value:
        data.duration_unit === '' || data.duration_unit === 'custom'
          ? 0
          : data.duration_value,
      duration_seconds:
        data.duration_unit === 'custom' ? data.duration_seconds : 0,
      expired_time: data.expired_time
        ? Math.floor(data.expired_time.getTime() / 1000)
        : 0,
      count: data.count || 1,
    }
  }
  return {
    name: data.name,
    type: REDEMPTION_TYPE_QUOTA,
    quota: parseQuotaFromDollars(data.quota_dollars),
    plan_id: 0,
    duration_unit: '',
    duration_value: 0,
    duration_seconds: 0,
    expired_time: data.expired_time
      ? Math.floor(data.expired_time.getTime() / 1000)
      : 0,
    count: data.count || 1,
  }
}

/**
 * Transform redemption data to form defaults
 */
export function transformRedemptionToFormDefaults(
  redemption: Redemption
): RedemptionFormValues {
  const type = redemptionTypeOf(redemption)
  const durationUnit = redemption.duration_unit
  return {
    name: redemption.name,
    type,
    quota_dollars: quotaUnitsToEditableAmount(redemption.quota),
    plan_id: type === REDEMPTION_TYPE_SUBSCRIPTION ? redemption.plan_id : 0,
    duration_unit:
      type === REDEMPTION_TYPE_SUBSCRIPTION &&
      (durationUnit === 'year' ||
        durationUnit === 'month' ||
        durationUnit === 'day' ||
        durationUnit === 'hour' ||
        durationUnit === 'custom')
        ? durationUnit
        : '',
    duration_value:
      type === REDEMPTION_TYPE_SUBSCRIPTION && redemption.duration_value > 0
        ? redemption.duration_value
        : REDEMPTION_FORM_DEFAULT_VALUES.duration_value,
    duration_seconds:
      type === REDEMPTION_TYPE_SUBSCRIPTION && redemption.duration_seconds > 0
        ? redemption.duration_seconds
        : REDEMPTION_FORM_DEFAULT_VALUES.duration_seconds,
    expired_time:
      redemption.expired_time > 0
        ? new Date(redemption.expired_time * 1000)
        : undefined,
    count: 1,
  }
}
