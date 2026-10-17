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
 * Wallet ledger kind to i18n key. Keep in sync with the
 * model.WalletLedgerKind* constants in model/wallet_ledger.go.
 */
export const WALLET_LEDGER_KIND_LABELS: Record<string, string> = {
  opening_balance: 'Opening Balance',
  topup: 'Top-up',
  redeem: 'Redeem',
  admin_adjust: 'Admin Adjust',
  refund: 'Refund',
  subscription_payment: 'Subscription Payment',
  checkin: 'Check-in',
  affiliate_transfer: 'Affiliate Transfer',
  system_grant: 'System Grant',
  consume_hourly: 'Hourly Consumption',
  chargeback: 'Chargeback',
  storage_daily: 'Storage Fee',
  debt: 'Wallet Debt',
  debt_repayment: 'Debt Repayment',
}

/**
 * i18n key for one ledger kind; unknown kinds fall back to the raw value.
 */
export function getWalletLedgerKindLabel(kind: string): string {
  return WALLET_LEDGER_KIND_LABELS[kind] ?? kind
}
