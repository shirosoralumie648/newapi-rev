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

import { getPlaygroundMCPServers } from '../api'
import { playgroundQueryKeys } from '../lib/query-keys'

/**
 * Reads the global MCP catalog: the tools of every administrator-enabled
 * connection. The request is sent only while the account switch is on, so a
 * disabled feature never touches the upstream connections. The catalog changes
 * only when an administrator edits the connections, so it stays fresh within
 * the session and a failed fetch keeps the previous list for the retry.
 */
export function usePlaygroundMCPCatalog(
  userId: number | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: playgroundQueryKeys.mcpServers(userId),
    queryFn: ({ signal }) => getPlaygroundMCPServers(signal),
    enabled: userId !== null && enabled,
    staleTime: 5 * 60 * 1000,
    meta: { errorToast: false, keepPageOnInternalServerError: true },
  })
}
