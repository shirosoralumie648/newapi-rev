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
import { useQuery } from '@tanstack/react-query'

import { requireServerSuccess } from '@/lib/server-error-message'

import { getReferralInvitations, getSelfReferralInvitations } from '../api'
import { EMPTY_REFERRAL_STATS_SUMMARY } from '../lib'
import type { ReferralInvitationFilters } from '../types'

/**
 * One page of the caller's own invitees. The previous page stays visible while
 * the next one loads, so paging does not flash the table; business failures
 * are rejected so the dialog can render them as an error state.
 */
export function useSelfReferralInvitations(
  page: number,
  pageSize: number,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['referral-invitations', 'self', page, pageSize],
    queryFn: async () => {
      const response = await getSelfReferralInvitations(page, pageSize)
      requireServerSuccess(response)
      return (
        response.data ?? {
          items: [],
          total: 0,
          window_months: 0,
          commission_enabled: false,
        }
      )
    },
    enabled,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}

/**
 * One page of the platform-wide invitation list with the summary of the
 * active filters (administrator view).
 */
export function useReferralInvitations(
  page: number,
  pageSize: number,
  filters: ReferralInvitationFilters,
  enabled: boolean
) {
  return useQuery({
    queryKey: [
      'referral-invitations',
      'admin',
      page,
      pageSize,
      filters.keyword ?? '',
      filters.source ?? '',
      filters.status ?? '',
    ],
    queryFn: async () => {
      const response = await getReferralInvitations(page, pageSize, filters)
      requireServerSuccess(response)
      return (
        response.data ?? {
          items: [],
          total: 0,
          window_months: 0,
          commission_enabled: false,
          summary: EMPTY_REFERRAL_STATS_SUMMARY,
        }
      )
    },
    enabled,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}
