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

import { getPlaygroundSettings } from '../api'
import { playgroundQueryKeys } from '../lib/query-keys'

/**
 * Reads the server-side Playground switches. The sandbox preview flag is the
 * authoritative artifact-content gate: until the server reports it enabled the
 * caller must not mount artifact content in the sandboxed iframe. An unanswered
 * request stays disabled.
 */
export function usePlaygroundSandboxSettings(userId: number | null) {
  return useQuery({
    queryKey: playgroundQueryKeys.settings(userId),
    queryFn: ({ signal }) => getPlaygroundSettings(signal),
    enabled: userId !== null,
    meta: { errorToast: false, keepPageOnInternalServerError: true },
  })
}
