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

import { getPlaygroundStorageBilling } from '../api'
import { playgroundQueryKeys } from '../lib/query-keys'

/**
 * The optional metered storage tier of the signed-in account. The endpoint is
 * read-only and also resolves any outstanding wallet debt, so the usage
 * popover can show the read-only grace state without a separate request.
 */
export function usePlaygroundStorageBilling(userId: number | null) {
  return useQuery({
    queryKey: playgroundQueryKeys.storageBilling(userId),
    queryFn: ({ signal }) => getPlaygroundStorageBilling(signal),
    enabled: userId !== null,
    meta: { errorToast: false, keepPageOnInternalServerError: true },
  })
}
