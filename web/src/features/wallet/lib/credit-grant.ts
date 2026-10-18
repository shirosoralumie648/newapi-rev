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

/**
 * Credit grant source to i18n key. Keep in sync with the
 * operation_setting.CreditGrantSource* constants in
 * setting/operation_setting/credit_grant_setting.go.
 */
export const CREDIT_GRANT_SOURCE_LABELS: Record<string, string> = {
  gift: 'Gift',
  checkin: 'Check-in',
  invite: 'Invite',
  redeem: 'Redeem',
  promo: 'Promo',
  admin: 'Admin',
}

/**
 * The sources an administrator can issue, in display order.
 */
export const CREDIT_GRANT_SOURCES = [
  'gift',
  'checkin',
  'invite',
  'redeem',
  'promo',
  'admin',
] as const

/**
 * i18n key for one grant source; unknown sources fall back to the raw value.
 */
export function getCreditGrantSourceLabel(source: string): string {
  return CREDIT_GRANT_SOURCE_LABELS[source] ?? source
}
