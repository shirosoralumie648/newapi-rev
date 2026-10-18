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
  clearUserReferralAgent,
  getReferralAgents,
  getSelfReferralAgent,
  setUserReferralAgent,
} from '../api'
import { EMPTY_REFERRAL_AGENT_PROFILE } from '../lib'
import type { ReferralAgentUpdateRequest } from '../types'

/**
 * The caller's own agent profile with the effective commission rate. The page
 * shows the empty profile while it loads; business failures are rejected so
 * the page can render them as an error state.
 */
export function useSelfReferralAgent() {
  return useQuery({
    queryKey: ['referral-agent', 'self'],
    queryFn: async () => {
      const response = await getSelfReferralAgent()
      requireServerSuccess(response)
      return response.data ?? EMPTY_REFERRAL_AGENT_PROFILE
    },
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}

/**
 * One page of the marked agent accounts with the tier catalogue (administrator
 * view); only requested for administrators.
 */
export function useReferralAgents(
  page: number,
  pageSize: number,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['referral-agent', 'admin', page, pageSize],
    queryFn: async () => {
      const response = await getReferralAgents(page, pageSize)
      requireServerSuccess(response)
      return response.data ?? { items: [], total: 0, tiers: [] }
    },
    enabled,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}

/**
 * Mark/update one account as a referral agent. The caller's own profile and
 * the administrator list are refreshed after the mark commits.
 */
export function useSetReferralAgentMark() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (variables: {
      userId: number
      request: ReferralAgentUpdateRequest
    }) => {
      const response = await setUserReferralAgent(
        variables.userId,
        variables.request
      )
      requireServerSuccess(response)
      return response
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['referral-agent'] })
    },
  })
}

/** Remove the agent mark of one account. */
export function useClearReferralAgentMark() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (userId: number) => {
      const response = await clearUserReferralAgent(userId)
      requireServerSuccess(response)
      return response
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['referral-agent'] })
    },
  })
}
