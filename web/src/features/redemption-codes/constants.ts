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

import type { StatusBadgeProps } from '@/components/status-badge'

import type { RedemptionType } from './types'

// ============================================================================
// Redemption Status Configuration
// ============================================================================

export const REDEMPTION_STATUS = {
  ENABLED: 1,
  DISABLED: 2,
  USED: 3,
} as const

export const REDEMPTION_STATUS_VALUES = Object.values(REDEMPTION_STATUS).map(
  (value) => String(value)
) as `${number}`[]

// labelKey values are i18n keys; use t(config.labelKey) in components
export const REDEMPTION_STATUSES: Record<
  number,
  Pick<StatusBadgeProps, 'variant'> & {
    labelKey: string
    value: number
  }
> = {
  [REDEMPTION_STATUS.ENABLED]: {
    labelKey: 'Unused',
    variant: 'success',
    value: REDEMPTION_STATUS.ENABLED,
  },
  [REDEMPTION_STATUS.DISABLED]: {
    labelKey: 'Disabled',
    variant: 'neutral',
    value: REDEMPTION_STATUS.DISABLED,
  },
  [REDEMPTION_STATUS.USED]: {
    labelKey: 'Used',
    variant: 'neutral',
    value: REDEMPTION_STATUS.USED,
  },
} as const

// Virtual status filter value for expired redemption codes
// Note: "Expired" is not a real DB status, it's computed from expired_time
export const REDEMPTION_FILTER_EXPIRED = 'expired'

export const REDEMPTION_FILTER_VALUES = [
  String(REDEMPTION_STATUS.ENABLED),
  String(REDEMPTION_STATUS.DISABLED),
  String(REDEMPTION_STATUS.USED),
  REDEMPTION_FILTER_EXPIRED,
] as const

export function getRedemptionStatusOptions(t: TFunction) {
  return [
    ...Object.values(REDEMPTION_STATUSES).map((config) => ({
      label: t(config.labelKey),
      value: String(config.value),
    })),
    {
      label: t('Expired'),
      value: REDEMPTION_FILTER_EXPIRED,
    },
  ]
}

// ============================================================================
// Redemption Types
// ============================================================================

// labelKey values are i18n keys; use t(config.labelKey) in components
export const REDEMPTION_TYPES: Record<
  RedemptionType,
  Pick<StatusBadgeProps, 'variant'> & { labelKey: string }
> = {
  quota: { labelKey: 'Quota', variant: 'neutral' },
  subscription: { labelKey: 'Subscription', variant: 'info' },
} as const

export const REDEMPTION_TYPE_VALUES = Object.keys(
  REDEMPTION_TYPES
) as RedemptionType[]

export function getRedemptionTypeOptions(t: TFunction) {
  return REDEMPTION_TYPE_VALUES.map((value) => ({
    label: t(REDEMPTION_TYPES[value].labelKey),
    value,
  }))
}

// ============================================================================
// Subscription Duration Overrides
// ============================================================================

// Duration override units mirror the subscription plan units. The bounds keep
// one code from granting an effectively permanent subscription (10 years).
export const REDEMPTION_DURATION_MAX_YEARS = 10

export const REDEMPTION_DURATION_UNITS = [
  'year',
  'month',
  'day',
  'hour',
  'custom',
] as const

export type RedemptionDurationUnit = (typeof REDEMPTION_DURATION_UNITS)[number]

export const REDEMPTION_DURATION_MAX_VALUE: Record<
  Exclude<RedemptionDurationUnit, 'custom'>,
  number
> = {
  year: REDEMPTION_DURATION_MAX_YEARS,
  month: REDEMPTION_DURATION_MAX_YEARS * 12,
  day: REDEMPTION_DURATION_MAX_YEARS * 365,
  hour: REDEMPTION_DURATION_MAX_YEARS * 365 * 24,
}

export const REDEMPTION_DURATION_MAX_SECONDS =
  REDEMPTION_DURATION_MAX_YEARS * 365 * 24 * 60 * 60

export function getRedemptionDurationUnitOptions(t: TFunction) {
  return [
    { value: '', label: t('Use plan duration') },
    { value: 'year', label: t('years') },
    { value: 'month', label: t('months') },
    { value: 'day', label: t('days') },
    { value: 'hour', label: t('hours') },
    { value: 'custom', label: t('Custom (seconds)') },
  ]
}

// ============================================================================
// Validation Constants
// ============================================================================

export const REDEMPTION_VALIDATION = {
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 20,
  COUNT_MIN: 1,
  COUNT_MAX: 100,
} as const

// ============================================================================
// Error Messages
// ============================================================================

// i18n keys; use t(ERROR_MESSAGES.xxx) when displaying. For form schema with interpolation use getRedemptionFormErrorMessages(t).
export const ERROR_MESSAGES = {
  UNEXPECTED: 'An unexpected error occurred',
  LOAD_FAILED: 'Failed to load redemption codes',
  SEARCH_FAILED: 'Failed to search redemption codes',
  CREATE_FAILED: 'Failed to create redemption code',
  UPDATE_FAILED: 'Failed to update redemption code',
  DELETE_FAILED: 'Failed to delete redemption code',
  DELETE_INVALID_FAILED: 'Failed to delete invalid redemption codes',
  STATUS_UPDATE_FAILED: 'Failed to update redemption code status',
  NAME_LENGTH_INVALID: 'Name must be between {{min}} and {{max}} characters',
  COUNT_INVALID: 'Count must be between {{min}} and {{max}}',
  EXPIRED_TIME_INVALID: 'Expired time cannot be earlier than current time',
  PLAN_REQUIRED: 'Select a subscription plan for this redemption code',
  DURATION_INVALID: 'Duration override must be a positive duration',
  DURATION_TOO_LONG: 'Duration override cannot exceed 10 years',
} as const

/** For form schema only: returns translated messages with interpolation. */
export function getRedemptionFormErrorMessages(t: TFunction) {
  return {
    NAME_LENGTH_INVALID: t(ERROR_MESSAGES.NAME_LENGTH_INVALID, {
      min: REDEMPTION_VALIDATION.NAME_MIN_LENGTH,
      max: REDEMPTION_VALIDATION.NAME_MAX_LENGTH,
    }),
    COUNT_INVALID: t(ERROR_MESSAGES.COUNT_INVALID, {
      min: REDEMPTION_VALIDATION.COUNT_MIN,
      max: REDEMPTION_VALIDATION.COUNT_MAX,
    }),
    EXPIRED_TIME_INVALID: t(ERROR_MESSAGES.EXPIRED_TIME_INVALID),
    PLAN_REQUIRED: t(ERROR_MESSAGES.PLAN_REQUIRED),
    DURATION_INVALID: t(ERROR_MESSAGES.DURATION_INVALID),
    DURATION_TOO_LONG: t(ERROR_MESSAGES.DURATION_TOO_LONG),
  } as const
}

// ============================================================================
// Success Messages (i18n keys; use t(SUCCESS_MESSAGES.xxx) when displaying)
// ============================================================================

export const SUCCESS_MESSAGES = {
  REDEMPTION_CREATED: 'Redemption code(s) created successfully',
  REDEMPTION_UPDATED: 'Redemption code updated successfully',
  REDEMPTION_DELETED: 'Redemption code deleted successfully',
  REDEMPTION_ENABLED: 'Redemption code enabled successfully',
  REDEMPTION_DISABLED: 'Redemption code disabled successfully',
  COPY_SUCCESS: 'Copied to clipboard',
} as const
