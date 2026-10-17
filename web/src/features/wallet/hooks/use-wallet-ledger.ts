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

import { getSelfWalletLedger, getUserWalletLedger } from '../api'

interface UseWalletLedgerOptions {
  /** Admin target user; omitted fetches the caller's own ledger. */
  userId?: number
  page: number
  pageSize: number
  enabled: boolean
}

/**
 * One page of the wallet ledger. The previous page stays visible while the
 * next one loads, so paging does not flash the table. Business failures are
 * rejected so the dialog can render them as an error state.
 */
export function useWalletLedger(options: UseWalletLedgerOptions) {
  const { userId, page, pageSize, enabled } = options

  return useQuery({
    queryKey: ['wallet-ledger', userId ?? 'self', page, pageSize],
    queryFn: async () => {
      const response = userId
        ? await getUserWalletLedger(userId, page, pageSize)
        : await getSelfWalletLedger(page, pageSize)
      requireServerSuccess(response)
      return response.data ?? { items: [], total: 0 }
    },
    enabled,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}
