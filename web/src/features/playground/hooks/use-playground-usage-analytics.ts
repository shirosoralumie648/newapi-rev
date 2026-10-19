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

import { getPlaygroundUsageAnalytics } from '../api'
import { playgroundQueryKeys } from '../lib/query-keys'

/**
 * The owner's settled usage over the selected range, read on demand while the
 * Usage Inspector is open. The answer is one bounded aggregate query, so the
 * range is part of the query key instead of a client-side filter.
 */
export function usePlaygroundUsageAnalytics(
  userId: number | null,
  days: number,
  enabled = true
) {
  return useQuery({
    queryKey: playgroundQueryKeys.usageAnalytics(userId, days),
    queryFn: ({ signal }) => getPlaygroundUsageAnalytics(days, signal),
    enabled: userId !== null && enabled,
    meta: { errorToast: false, keepPageOnInternalServerError: true },
  })
}
