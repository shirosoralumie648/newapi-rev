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

import { getPlaygroundStorageLedger } from '../playground/api'

interface UsePlaygroundStorageLedgerOptions {
  /** Restricts the view to one account; omitted lists every account. */
  userId?: number
  start?: string
  end?: string
  page: number
  pageSize: number
  enabled: boolean
}

/**
 * One page of the daily storage ledger. The previous page stays visible while
 * the next one loads; business failures are rejected so the dialog can render
 * them as an error state.
 */
export function usePlaygroundStorageLedger(
  options: UsePlaygroundStorageLedgerOptions
) {
  const { userId, start, end, page, pageSize, enabled } = options

  return useQuery({
    queryKey: [
      'playground-storage-ledger',
      userId ?? 'all',
      start ?? '',
      end ?? '',
      page,
      pageSize,
    ],
    queryFn: async () =>
      getPlaygroundStorageLedger({ userId, start, end }, page, pageSize),
    enabled,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}
