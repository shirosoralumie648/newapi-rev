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
import type { ReferralInvitation, ReferralStatsSummary } from '../types'

// ============================================================================
// Referral Statistics Helpers
// ============================================================================

/** Binding sources recorded by the backend, mapped to their translation key. */
export const REFERRAL_SOURCE_LABEL_KEYS: Record<string, string> = {
  link: 'Link',
  code: 'Invitation Code',
  oauth: 'OAuth',
  admin: 'Admin',
}

/** Commission states of one invitation or event, mapped to their translation key. */
export const REFERRAL_COMMISSION_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'Pending',
  locked: 'Locked',
  settled: 'Settled',
  review: 'Under review',
  blocked: 'Blocked',
  rejected: 'Rejected',
}

/** Anti-abuse mark levels an administrator can set, with their translation key. */
export const REFERRAL_FLAG_LEVEL_LABEL_KEYS: Record<string, string> = {
  watch: 'Watch',
  frozen: 'Frozen',
  clear: 'Clear',
}

/** Mark levels the anti-abuse form offers; clear removes the mark. */
export const REFERRAL_FLAG_LEVEL_VALUES = ['watch', 'frozen', 'clear'] as const

/** Review reasons recorded by the payout gate, mapped to translation keys. */
export const REFERRAL_COMMISSION_REASON_LABEL_KEYS: Record<string, string> = {
  watch_flag: 'Watched account',
  review_threshold: 'Above the review threshold',
}

/** Source filter options of the administrator invitation list. */
export const REFERRAL_SOURCE_FILTER_VALUES = [
  'link',
  'code',
  'oauth',
  'admin',
] as const

/** Commission-status filter options of the administrator invitation list. */
export const REFERRAL_COMMISSION_STATUS_FILTER_VALUES = [
  'pending',
  'locked',
  'settled',
] as const

/** Summary shown before the administrator page has loaded. */
export const EMPTY_REFERRAL_STATS_SUMMARY: ReferralStatsSummary = {
  total_invitees: 0,
  invitees_with_commission: 0,
  total_paid_quota: 0,
  total_commission_quota: 0,
  pending_quota: 0,
  locked_quota: 0,
  settled_quota: 0,
}

/**
 * Translation key of a binding source; an unknown source recorded by a newer
 * backend stays readable as-is.
 */
export function getReferralSourceLabelKey(source: string): string {
  return REFERRAL_SOURCE_LABEL_KEYS[source] ?? source
}

/**
 * Translation label of one commission state; an unknown state recorded by a
 * newer backend stays readable as-is.
 */
export function getReferralCommissionStatusLabelKey(status: string): string {
  return REFERRAL_COMMISSION_STATUS_LABEL_KEYS[status] ?? status
}

/**
 * Translation key of one anti-abuse mark level; an unknown level stays
 * readable as-is.
 */
export function getReferralFlagLevelLabelKey(level: string): string {
  return REFERRAL_FLAG_LEVEL_LABEL_KEYS[level] ?? level
}

/**
 * Translation key of one manual-review reason; an unknown reason recorded by a
 * newer backend stays readable as-is.
 */
export function getReferralCommissionReasonLabelKey(reason: string): string {
  return REFERRAL_COMMISSION_REASON_LABEL_KEYS[reason] ?? reason
}

/** Total commission of one invitation across every recorded state. */
export function referralCommissionTotal(
  invitation: ReferralInvitation
): number {
  return (
    invitation.pending_quota +
    invitation.locked_quota +
    invitation.settled_quota
  )
}

/**
 * Translation keys of the commission states the invitation actually has, so a
 * row names pending, locked and settled amounts without inventing states.
 */
export function getReferralCommissionStatusLabelKeys(
  invitation: ReferralInvitation
): string[] {
  const keys: string[] = []
  if (invitation.pending_quota > 0) {
    keys.push(REFERRAL_COMMISSION_STATUS_LABEL_KEYS.pending)
  }
  if (invitation.locked_quota > 0) {
    keys.push(REFERRAL_COMMISSION_STATUS_LABEL_KEYS.locked)
  }
  if (invitation.settled_quota > 0) {
    keys.push(REFERRAL_COMMISSION_STATUS_LABEL_KEYS.settled)
  }
  return keys
}
