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

import { getPlaygroundMessageCosts } from '../api'
import {
  PLAYGROUND_COST_LOOKUP_MAX_ATTEMPTS,
  PLAYGROUND_COST_LOOKUP_POLL_INTERVAL_MS,
} from '../constants'
import { playgroundQueryKeys } from '../lib/query-keys'

/**
 * Settled cost rows for the conversation's relay requests. The lookup is
 * read-only and owner-scoped. A settle row is written just after the stream
 * ends, so a lookup that still misses ids retries a bounded number of times;
 * it stops immediately when the runtime has consume logs switched off, because
 * then no row can ever appear.
 */
export function usePlaygroundMessageCosts(
  userId: number | null,
  requestIds: string[]
) {
  const lookupKey = requestIds.join(',')
  return useQuery({
    queryKey: playgroundQueryKeys.messageCosts(userId, lookupKey),
    enabled: userId !== null && requestIds.length > 0,
    queryFn: ({ signal }) => getPlaygroundMessageCosts(requestIds, signal),
    meta: { errorToast: false, keepPageOnInternalServerError: true },
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data || !data.enabled) return false
      if (requestIds.every((id) => data.costs.has(id))) return false
      if (query.state.dataUpdateCount >= PLAYGROUND_COST_LOOKUP_MAX_ATTEMPTS) {
        return false
      }
      return PLAYGROUND_COST_LOOKUP_POLL_INTERVAL_MS
    },
  })
}
