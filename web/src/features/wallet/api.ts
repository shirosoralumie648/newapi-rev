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
import { api } from '@/lib/api'

import type {
  RedemptionRequest,
  PaymentRequest,
  AmountRequest,
  AffiliateTransferRequest,
  ApiResponse,
  TopupInfoResponse,
  RedemptionResponse,
  AmountResponse,
  PaymentResponse,
  StripePaymentResponse,
  AffiliateCodeResponse,
  AffiliateTransferResponse,
  BillingHistoryResponse,
  CompleteOrderRequest,
  CreemPaymentRequest,
  CreemPaymentResponse,
  WaffoPaymentRequest,
  WaffoPaymentResponse,
  WaffoPancakePaymentRequest,
  WaffoPancakePaymentResponse,
  WalletLedgerPage,
  WalletDebtorPage,
  CreditGrantIssueRequest,
  CreditGrantStats,
  CreditGrantWallet,
  ReferralInvitationPage,
  ReferralAdminInvitationPage,
  ReferralInvitationFilters,
} from './types'

// ============================================================================
// Wallet API Functions
// ============================================================================

/**
 * Check if API response is successful
 */
export function isApiSuccess(response: ApiResponse): boolean {
  return response.success === true || response.message === 'success'
}

/**
 * Get topup configuration info
 */
export async function getTopupInfo(): Promise<TopupInfoResponse> {
  const res = await api.get('/api/user/topup/info')
  return res.data
}

/**
 * Redeem a topup code
 */
export async function redeemTopupCode(
  request: RedemptionRequest
): Promise<RedemptionResponse> {
  const res = await api.post('/api/user/topup', request)
  return res.data
}

/**
 * Calculate payment amount for regular payment
 */
export async function calculateAmount(
  request: AmountRequest
): Promise<AmountResponse> {
  const res = await api.post('/api/user/amount', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Calculate payment amount for Stripe payment
 */
export async function calculateStripeAmount(
  request: AmountRequest
): Promise<AmountResponse> {
  const res = await api.post('/api/user/stripe/amount', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Calculate payment amount for Waffo payment
 */
export async function calculateWaffoAmount(
  request: AmountRequest
): Promise<AmountResponse> {
  const res = await api.post('/api/user/waffo/amount', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Request regular payment
 */
export async function requestPayment(
  request: PaymentRequest
): Promise<PaymentResponse> {
  const res = await api.post('/api/user/pay', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return {
    ...res.data,
    url: res.data.url || (res as unknown as { url?: string }).url,
  }
}

/**
 * Request Stripe payment
 */
export async function requestStripePayment(
  request: PaymentRequest
): Promise<StripePaymentResponse> {
  const res = await api.post('/api/user/stripe/pay', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Request Creem payment
 */
export async function requestCreemPayment(
  request: CreemPaymentRequest
): Promise<CreemPaymentResponse> {
  const res = await api.post('/api/user/creem/pay', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Request Waffo payment
 */
export async function requestWaffoPayment(
  request: WaffoPaymentRequest
): Promise<WaffoPaymentResponse> {
  const res = await api.post('/api/user/waffo/pay', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Calculate payment amount for Waffo Pancake payment
 */
export async function calculateWaffoPancakeAmount(
  request: AmountRequest
): Promise<AmountResponse> {
  const res = await api.post('/api/user/waffo-pancake/amount', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Request Waffo Pancake payment
 */
export async function requestWaffoPancakePayment(
  request: WaffoPancakePaymentRequest
): Promise<WaffoPancakePaymentResponse> {
  const res = await api.post('/api/user/waffo-pancake/pay', request, {
    skipBusinessError: true,
  } as Record<string, unknown>)
  return res.data
}

/**
 * Get affiliate code
 */
export async function getAffiliateCode(): Promise<AffiliateCodeResponse> {
  const res = await api.get('/api/user/aff')
  return res.data
}

/**
 * Transfer affiliate quota to balance
 */
export async function transferAffiliateQuota(
  request: AffiliateTransferRequest
): Promise<AffiliateTransferResponse> {
  const res = await api.post('/api/user/aff_transfer', request)
  return res.data
}

/**
 * Get billing history for current user
 */
export async function getUserBillingHistory(
  page: number,
  pageSize: number,
  keyword?: string
): Promise<ApiResponse<BillingHistoryResponse>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  if (keyword) {
    params.append('keyword', keyword)
  }
  const res = await api.get(`/api/user/topup/self?${params.toString()}`)
  return res.data
}

/**
 * Get billing history for all users (admin only)
 */
export async function getAllBillingHistory(
  page: number,
  pageSize: number,
  keyword?: string
): Promise<ApiResponse<BillingHistoryResponse>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  if (keyword) {
    params.append('keyword', keyword)
  }
  const res = await api.get(`/api/user/topup?${params.toString()}`)
  return res.data
}

/**
 * Complete a pending order (admin only)
 */
export async function completeOrder(
  request: CompleteOrderRequest
): Promise<ApiResponse> {
  const res = await api.post('/api/user/topup/complete', request)
  return res.data
}

// ============================================================================
// Wallet Ledger API Functions
// ============================================================================

/**
 * Get the caller's own wallet ledger entries
 */
export async function getSelfWalletLedger(
  page: number,
  pageSize: number
): Promise<ApiResponse<WalletLedgerPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  const res = await api.get(`/api/user/self/wallet/ledger?${params.toString()}`)
  return res.data
}

/**
 * Get one user's wallet ledger entries (admin only)
 */
export async function getUserWalletLedger(
  userId: number,
  page: number,
  pageSize: number
): Promise<ApiResponse<WalletLedgerPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  const res = await api.get(
    `/api/user/${userId}/wallet/ledger?${params.toString()}`
  )
  return res.data
}

/**
 * Fetch the wallet ledger as a CSV blob; the caller's own ledger when userId
 * is omitted. The caller decides when to save the blob.
 */
export async function exportWalletLedgerCsv(userId?: number): Promise<Blob> {
  const path = userId
    ? `/api/user/${userId}/wallet/ledger/export`
    : '/api/user/self/wallet/ledger/export'
  const res = await api.get(path, { responseType: 'blob' })
  return res.data as Blob
}

/**
 * List accounts with outstanding wallet debt (admin only).
 */
export async function getWalletDebtors(
  page: number,
  pageSize: number
): Promise<ApiResponse<WalletDebtorPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  const res = await api.get(`/api/user/wallet/debts?${params.toString()}`)
  return res.data
}

// ============================================================================
// Referral Statistics API Functions
// ============================================================================

/**
 * Get the caller's own invitees with masked identifiers and the aggregates of
 * their commission events.
 */
export async function getSelfReferralInvitations(
  page: number,
  pageSize: number
): Promise<ApiResponse<ReferralInvitationPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  const res = await api.get(`/api/user/self/referrals?${params.toString()}`)
  return res.data
}

/** The keyword/source/status query parameters shared by list and export. */
function referralInvitationFilterParams(
  filters: ReferralInvitationFilters
): URLSearchParams {
  const params = new URLSearchParams()
  const keyword = filters.keyword?.trim()
  if (keyword) {
    params.set('keyword', keyword)
  }
  if (filters.source) {
    params.set('source', filters.source)
  }
  if (filters.status) {
    params.set('status', filters.status)
  }
  return params
}

/**
 * List every invitation platform-wide with the summary of the active filters
 * (admin only).
 */
export async function getReferralInvitations(
  page: number,
  pageSize: number,
  filters: ReferralInvitationFilters = {}
): Promise<ApiResponse<ReferralAdminInvitationPage>> {
  const params = new URLSearchParams({
    p: page.toString(),
    page_size: pageSize.toString(),
  })
  for (const [key, value] of referralInvitationFilterParams(filters)) {
    params.set(key, value)
  }
  const res = await api.get(`/api/user/referrals?${params.toString()}`)
  return res.data
}

/**
 * Fetch the filtered invitation list as a CSV blob (admin only). The caller
 * decides when to save the blob.
 */
export async function exportReferralInvitationsCsv(
  filters: ReferralInvitationFilters = {}
): Promise<Blob> {
  const params = referralInvitationFilterParams(filters)
  const query = params.toString()
  const res = await api.get(
    `/api/user/referrals/export${query ? `?${query}` : ''}`,
    { responseType: 'blob' }
  )
  return res.data as Blob
}

// ============================================================================
// Credit Grant API Functions
// ============================================================================

/**
 * Get the caller's own wallet composition (paid balance and grant buckets).
 */
export async function getSelfCreditGrants(): Promise<
  ApiResponse<CreditGrantWallet>
> {
  const res = await api.get('/api/user/self/wallet/grants')
  return res.data
}

/**
 * Get one user's wallet composition (admin only).
 */
export async function getUserCreditGrants(
  userId: number
): Promise<ApiResponse<CreditGrantWallet>> {
  const res = await api.get(`/api/user/${userId}/wallet/grants`)
  return res.data
}

/**
 * Get the wallet totals administrators audit by grant source (admin only).
 */
export async function getCreditGrantStats(): Promise<
  ApiResponse<CreditGrantStats>
> {
  const res = await api.get('/api/user/wallet/grants/stats')
  return res.data
}

/**
 * Issue a grant-typed credit to one user (admin only).
 */
export async function issueCreditGrant(
  request: CreditGrantIssueRequest
): Promise<ApiResponse> {
  const res = await api.post('/api/user/wallet/grants', request)
  return res.data
}
