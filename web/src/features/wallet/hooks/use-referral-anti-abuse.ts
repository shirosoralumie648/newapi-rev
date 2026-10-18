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
  clearUserReferralIdentity,
  decideReferralCommissionReview,
  getReferralCommissionReviews,
  getUserReferralProfile,
  setUserReferralFlag,
  setUserReferralIdentity,
} from '../api'
import type { ReferralFlagLevel, ReferralReviewDecision } from '../types'

/**
 * The anti-abuse profile of one managed account: registration signal, identity
 * correlation prefix, flag and commission summary. Business failures are
 * rejected so the dialog can render them as an error state.
 */
export function useUserReferralProfile(
  userId: number | undefined,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['referral-profile', userId ?? 0],
    queryFn: async () => {
      const response = await getUserReferralProfile(userId as number)
      requireServerSuccess(response)
      return response.data ?? null
    },
    enabled: enabled && typeof userId === 'number' && userId > 0,
    meta: { errorToast: false },
  })
}

/** Set or clear the anti-abuse mark of one account. */
export function useSetUserReferralFlag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: {
      userId: number
      level: ReferralFlagLevel
      note?: string
    }) => {
      requireServerSuccess(
        await setUserReferralFlag(request.userId, {
          level: request.level,
          note: request.note,
        })
      )
    },
    onSuccess: (_data, request) => {
      void queryClient.invalidateQueries({
        queryKey: ['referral-profile', request.userId],
      })
    },
  })
}

/** Record the verified real-name identity of one account. */
export function useSetUserReferralIdentity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: { userId: number; identity: string }) => {
      requireServerSuccess(
        await setUserReferralIdentity(request.userId, request.identity)
      )
    },
    onSuccess: (_data, request) => {
      void queryClient.invalidateQueries({
        queryKey: ['referral-profile', request.userId],
      })
    },
  })
}

/** Remove the recorded real-name identity of one account. */
export function useClearUserReferralIdentity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: { userId: number }) => {
      requireServerSuccess(await clearUserReferralIdentity(request.userId))
    },
    onSuccess: (_data, request) => {
      void queryClient.invalidateQueries({
        queryKey: ['referral-profile', request.userId],
      })
    },
  })
}

/**
 * One page of the commission events waiting for a manual decision. The
 * previous page stays visible while the next one loads.
 */
export function useReferralCommissionReviews(
  page: number,
  pageSize: number,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['referral-reviews', page, pageSize],
    queryFn: async () => {
      const response = await getReferralCommissionReviews(page, pageSize)
      requireServerSuccess(response)
      return response.data ?? { items: [], total: 0 }
    },
    enabled,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}

/** Approve or reject one reviewed commission event. */
export function useDecideReferralCommissionReview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: {
      id: number
      decision: ReferralReviewDecision
    }) => {
      requireServerSuccess(
        await decideReferralCommissionReview(request.id, request.decision)
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['referral-reviews'] })
    },
  })
}
