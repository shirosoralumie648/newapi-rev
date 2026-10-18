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
// ============================================================================
// Wallet Type Definitions
// ============================================================================

/**
 * Generic API response
 */
export interface ApiResponse<T = unknown> {
  success?: boolean
  message?: string
  data?: T
}

/**
 * Standard API response types
 */
export type TopupInfoResponse = ApiResponse<TopupInfo>

/** Result of redeeming a code: quota credited or subscription activated. */
export interface RedemptionResult {
  type: string
  quota: number
  plan_id: number
  plan_title: string
  subscription_id: number
  end_time: number
}

export type RedemptionResponse = ApiResponse<RedemptionResult>
export type AmountResponse = ApiResponse<string>
export type PaymentResponse = ApiResponse<Record<string, unknown>> & {
  url?: string
}
export type StripePaymentResponse = ApiResponse<{ pay_link: string }>
export type AffiliateCodeResponse = ApiResponse<string>
export type AffiliateTransferResponse = ApiResponse
export type CreemPaymentResponse = ApiResponse<{ checkout_url: string }>
export type WaffoPaymentResponse = ApiResponse<
  { payment_url?: string } | string
>
export type WaffoPancakePaymentResponse = ApiResponse<
  | {
      checkout_url?: string
      session_id?: string
      expires_at?: number | string
      order_id?: string
      // Self-service session token + expiry — surfaced by the backend so
      // future flows (refund / cancel from new-api's own UI) can use them
      // without re-issuing checkout. Not consumed by the current handler.
      token?: string
      token_expires_at?: number | string
    }
  | string
>

/**
 * Creem product configuration
 */
export interface CreemProduct {
  /** Product display name */
  name: string
  /** Creem product ID */
  productId: string
  /** Product price */
  price: number
  /** Quota amount to credit */
  quota: number
  /** Currency (USD or EUR) */
  currency: 'USD' | 'EUR'
}

/**
 * Creem payment request
 */
export interface CreemPaymentRequest {
  /** Creem product ID */
  product_id: string
  /** Payment method identifier */
  payment_method: 'creem'
}

/**
 * Payment method configuration
 */
export interface PaymentMethod {
  /** Display name of payment method */
  name: string
  /** Payment method type identifier */
  type: string
  /** Legacy optional color for UI display */
  color?: string
  /** Minimum topup amount for this payment method */
  min_topup?: number
  /** Optional react-icons component name or safe icon URL */
  icon?: string
}

/**
 * Waffo payment method configuration
 */
export interface WaffoPayMethod {
  /** Display name of payment method */
  name: string
  /** Optional icon path */
  icon?: string
  /** Waffo pay method type */
  payMethodType?: string
  /** Waffo pay method name */
  payMethodName?: string
}

/**
 * Topup configuration information
 */
export interface TopupInfo {
  /** Whether online topup is enabled */
  enable_online_topup: boolean
  /** Whether Stripe topup is enabled */
  enable_stripe_topup: boolean
  /** Available payment methods */
  pay_methods: PaymentMethod[]
  /** Minimum topup amount for online topup */
  min_topup: number
  /** Minimum topup amount for Stripe */
  stripe_min_topup: number
  /** Preset amount options */
  amount_options: number[]
  /** Discount rates by amount */
  discount: Record<number, number>
  /** Optional topup link for purchasing codes */
  topup_link?: string
  /** Whether Creem topup is enabled */
  enable_creem_topup?: boolean
  /** Available Creem products */
  creem_products?: CreemProduct[]
  /** Whether Waffo topup is enabled */
  enable_waffo_topup?: boolean
  /** Available Waffo payment methods */
  waffo_pay_methods?: WaffoPayMethod[]
  /** Minimum topup amount for Waffo */
  waffo_min_topup?: number
  /** Whether Waffo Pancake topup is enabled */
  enable_waffo_pancake_topup?: boolean
  /** Minimum topup amount for Waffo Pancake */
  waffo_pancake_min_topup?: number
  /** Whether redemption code usage is enabled */
  enable_redemption?: boolean
  /** Whether compliance confirmation has been completed */
  payment_compliance_confirmed?: boolean
  /** Current compliance terms version */
  payment_compliance_terms_version?: string
}

/**
 * Preset amount option with optional discount
 */
export interface PresetAmount {
  /** Preset amount value */
  value: number
  /** Optional discount rate (0-1) */
  discount?: number
}

/**
 * Redemption code request
 */
export interface RedemptionRequest {
  /** Redemption code key */
  key: string
}

/**
 * Payment request parameters
 */
export interface PaymentRequest {
  /** Topup amount */
  amount: number
  /** Payment method identifier */
  payment_method: string
}

/**
 * Waffo payment request parameters
 */
export interface WaffoPaymentRequest {
  /** Topup amount */
  amount: number
  /** Optional server-side Waffo payment method index */
  pay_method_index?: number
}

/**
 * Waffo Pancake payment request parameters
 */
export interface WaffoPancakePaymentRequest {
  /** Topup amount */
  amount: number
}

/**
 * Amount calculation request
 */
export interface AmountRequest {
  /** Topup amount to calculate */
  amount: number
}

/**
 * Affiliate quota transfer request
 */
export interface AffiliateTransferRequest {
  /** Quota amount to transfer */
  quota: number
}

/**
 * User wallet data
 */
export interface UserWalletData {
  /** User ID */
  id: number
  /** Username */
  username: string
  /** Current quota balance */
  quota: number
  /** Total used quota */
  used_quota: number
  /** Total request count */
  request_count: number
  /** Affiliate quota (pending rewards) */
  aff_quota: number
  /** Total affiliate quota earned (historical) */
  aff_history_quota: number
  /** Number of successful affiliate invites */
  aff_count: number
  /** User group */
  group: string
}

/**
 * Topup record status
 */
export type TopupStatus =
  | 'success'
  | 'pending'
  | 'expired'
  | 'refunded'
  | 'disputed'

/**
 * Topup billing record
 */
export interface TopupRecord {
  /** Record ID */
  id: number
  /** User ID */
  user_id: number
  /** Topup amount (quota) */
  amount: number
  /**
   * Payment amount actually charged, stored as an exact decimal and
   * serialized by the backend as a string (legacy records may be numbers).
   */
  money: string | number
  /** ISO 4217 currency the payment was collected in, when the provider reported one */
  currency?: string
  /** Trade/order number */
  trade_no: string
  /** Payment method type */
  payment_method: string
  /** Creation timestamp */
  create_time: number
  /** Completion timestamp */
  complete_time?: number
  /** Payment status */
  status: TopupStatus
  /** Provider-side payment reference (e.g. Stripe payment intent) */
  provider_payment_id?: string
  /** Timestamp of the provider refund or chargeback, when reversed */
  refund_time?: number
}

/**
 * Billing history response
 */
export interface BillingHistoryResponse {
  items: TopupRecord[]
  total: number
}

/**
 * One append-only wallet ledger entry. `amount` is positive for credits and
 * negative for debits; `balance_after` is the wallet balance after the row
 * was applied.
 */
export interface WalletLedgerEntry {
  id: number
  user_id: number
  kind: string
  amount: number
  balance_after: number
  ref_type: string
  ref_id: string
  created_at: number
  meta?: string
}

/**
 * Paginated wallet ledger response
 */
export interface WalletLedgerPage {
  items: WalletLedgerEntry[]
  total: number
}

/**
 * One account with outstanding wallet debt. Amounts are quota values; the
 * account is read-only while `debt` is positive.
 */
export interface WalletDebtor {
  user_id: number
  username: string
  group: string
  quota: number
  debt: number
  updated_at: number
}

/**
 * Paginated outstanding wallet debt response
 */
export interface WalletDebtorPage {
  items: WalletDebtor[]
  total: number
}

/**
 * Complete order request (admin only)
 */
export interface CompleteOrderRequest {
  trade_no: string
}

/**
 * One credit grant bucket: the amount credited by one event, what is still
 * unspent and when the remainder stops being spendable (0 never expires).
 */
export interface CreditGrantBucket {
  grant_id: number
  source: string
  remaining: number
  expires_at: number
  created_at: number
}

/**
 * Wallet composition of one account: the paid balance that never expires, the
 * grant buckets still spendable and the expired remainder the sweep has not
 * voided yet.
 */
export interface CreditGrantWallet {
  user_id: number
  total_quota: number
  paid_quota: number
  grant_quota: number
  expired_quota: number
  grants: CreditGrantBucket[]
}

/**
 * One grant source in the administrator overview.
 */
export interface CreditGrantSourceStats {
  source: string
  granted: number
  remaining: number
  spent: number
  grants: number
  accounts: number
}

/**
 * Administrator overview of the wallet: money that entered through top-ups,
 * granted credit broken down by source, consumption, refunds and the credit
 * that expired unused.
 */
export interface CreditGrantStats {
  total_topup: number
  total_granted: number
  total_remaining: number
  total_spent: number
  total_consumed: number
  total_refunded: number
  total_expired: number
  sources: CreditGrantSourceStats[]
}

/**
 * Administrator credit grant issuance. `expires_in_days` is optional: omitted
 * keeps the configured validity of the source, 0 issues credit that never
 * expires.
 */
export interface CreditGrantIssueRequest {
  user_id: number
  source: string
  quota: number
  expires_in_days?: number
  note?: string
}

// ============================================================================
// Referral Statistics Types
// ============================================================================

/**
 * One invitation with the aggregates of its commission events. `identifier`
 * is the masked invitee account shown to the inviter; the administrator view
 * carries the raw `username`, `email` and `display_name` instead. Quota
 * amounts are read-only and split by commission state.
 */
export interface ReferralInvitation {
  invitee_id: number
  identifier?: string
  username?: string
  email?: string
  display_name?: string
  inviter_id?: number
  inviter_username?: string
  source: string
  bound_at: number
  commission_ends_at: number
  pending_quota: number
  locked_quota: number
  settled_quota: number
  /** Administrator view only: events waiting for a manual decision. */
  review_quota?: number
  /** Administrator view only: events refused by an anti-abuse rule. */
  blocked_quota?: number
  /** Administrator view only: events declined in review. */
  rejected_quota?: number
  total_paid_quota: number
  commission_count: number
}

export type ReferralInvitationPage = {
  items: ReferralInvitation[]
  total: number
  /** 0 = first paid order only, -1 = no expiry, otherwise months from sign-up. */
  window_months: number
  commission_enabled: boolean
}

export type ReferralAdminInvitationPage = ReferralInvitationPage & {
  summary: ReferralStatsSummary
}

/** Aggregates of the listed invitations under the active filters. */
export interface ReferralStatsSummary {
  total_invitees: number
  invitees_with_commission: number
  total_paid_quota: number
  total_commission_quota: number
  pending_quota: number
  locked_quota: number
  settled_quota: number
  review_quota: number
  blocked_quota: number
  rejected_quota: number
}

/** Administrator filters of the invitation list; empty string means "any". */
export interface ReferralInvitationFilters {
  keyword?: string
  source?: string
  status?: string
}

// ============================================================================
// Referral Anti-Abuse Types
// ============================================================================

/**
 * The registration environment of one account, recorded in the same
 * transaction as the account. A missing signal means the environment was not
 * observable (for example an administrator-created account).
 */
export interface ReferralRegistrationSignal {
  id: number
  user_id: number
  ip: string
  device_hash: string
  email_domain: string
  user_agent: string
  created_at: number
}

/** The administrator's anti-abuse mark on one account. */
export interface ReferralFlag {
  id: number
  user_id: number
  level: string
  note: string
  marked_by: number
  created_at: number
  updated_at: number
}

/** One commission-status bucket of an account's commission history. */
export interface ReferralCommissionStatusCount {
  status: string
  count: number
  quota: number
}

/** The administrator's anti-abuse view of one account. */
export interface ReferralProfile {
  user_id: number
  signal: ReferralRegistrationSignal | null
  identity_linked: boolean
  identity_ref: string
  flag: ReferralFlag | null
  invitees: number
  commissions: ReferralCommissionStatusCount[]
}

/** The anti-abuse mark levels an administrator can set; clear removes it. */
export type ReferralFlagLevel = 'watch' | 'frozen' | 'clear'

/** One recorded commission event, as the review queue lists it. */
export interface ReferralCommissionRecord {
  id: number
  inviter_id: number
  invitee_id: number
  source: string
  ref_type: string
  ref_id: string
  base_quota: number
  rate_percent: string
  commission_quota: number
  status: string
  reason: string
  created_at: number
  updated_at: number
}

export interface ReferralReviewPage {
  items: ReferralCommissionRecord[]
  total: number
}

/** Manual decision of one reviewed commission event. */
export type ReferralReviewDecision = 'approve' | 'reject'
