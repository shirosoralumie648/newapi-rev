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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { requireServerSuccess } from '@/lib/server-error-message'

import {
  getCreditGrantStats,
  getSelfCreditGrants,
  getUserCreditGrants,
  issueCreditGrant,
} from '../api'
import type { CreditGrantIssueRequest, CreditGrantWallet } from '../types'

const EMPTY_WALLET: CreditGrantWallet = {
  user_id: 0,
  total_quota: 0,
  paid_quota: 0,
  grant_quota: 0,
  expired_quota: 0,
  grants: [],
}

/**
 * The caller's own wallet composition (paid balance and grant buckets).
 * Business failures are rejected so the card can render an error state.
 */
export function useSelfCreditGrants(enabled = true) {
  return useQuery({
    queryKey: ['credit-grants', 'self'],
    queryFn: async () => {
      const response = await getSelfCreditGrants()
      requireServerSuccess(response)
      return response.data ?? EMPTY_WALLET
    },
    enabled,
    meta: { errorToast: false },
  })
}

/**
 * One user's wallet composition (admin view of the credit grant buckets).
 */
export function useUserCreditGrants(
  userId: number | undefined,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['credit-grants', 'user', userId ?? 0],
    queryFn: async () => {
      const response = await getUserCreditGrants(userId as number)
      requireServerSuccess(response)
      return response.data ?? EMPTY_WALLET
    },
    enabled: enabled && typeof userId === 'number' && userId > 0,
    meta: { errorToast: false },
  })
}

/**
 * The wallet totals administrators audit by grant source. Only requested for
 * administrators, because the endpoint requires the user:read capability.
 */
export function useCreditGrantStats(enabled: boolean) {
  return useQuery({
    queryKey: ['credit-grants', 'stats'],
    queryFn: async () => {
      const response = await getCreditGrantStats()
      requireServerSuccess(response)
      return response.data ?? null
    },
    enabled,
    meta: { errorToast: false },
  })
}

/**
 * Issue a grant-typed credit to one user. Both the target user's buckets and
 * the administrator overview are refreshed after the credit commits.
 */
export function useIssueCreditGrant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: CreditGrantIssueRequest) => {
      const response = await issueCreditGrant(request)
      requireServerSuccess(response)
      return response
    },
    onSuccess: (_data, request) => {
      void queryClient.invalidateQueries({
        queryKey: ['credit-grants', 'user', request.user_id],
      })
      void queryClient.invalidateQueries({
        queryKey: ['credit-grants', 'stats'],
      })
    },
  })
}
