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
 * Referral attribution helpers for the password registration form.
 */

export type ReferralSource = 'link' | 'code'

export interface ReferralAttribution {
  affCode?: string
  referralSource?: ReferralSource
}

/**
 * Resolve the invitation attribution submitted with a password registration.
 * An emptied field attributes nothing; a code still matching the one the
 * visitor arrived with keeps the link channel, any other code is hand-entered.
 */
export function referralAttribution(
  inviteCode: string,
  linkInviteCode: string
): ReferralAttribution {
  const code = inviteCode.trim()
  if (!code) {
    return {}
  }
  return {
    affCode: code,
    referralSource: code === linkInviteCode.trim() ? 'link' : 'code',
  }
}
