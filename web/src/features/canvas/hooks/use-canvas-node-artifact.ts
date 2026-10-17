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

import { getTaskArtifacts } from '@/features/usage-logs/api'
import type {
  TaskArtifact,
  TaskArtifactType,
} from '@/features/usage-logs/types'
import { requireServerSuccess } from '@/lib/server-error-message'

export interface CanvasNodeArtifact {
  artifact?: TaskArtifact
  isPending: boolean
  isError: boolean
}

/**
 * Resolves the media artifact a `video`/`audio` node plays. The projection is
 * read through the owner-scoped task route and shares its cache entry with the
 * usage-log views; the node stores the task id and artifact key only, so no
 * URL is ever persisted on the board.
 */
export function useCanvasNodeArtifact(
  taskId: string | undefined,
  artifactKey: string | undefined,
  expected: TaskArtifactType
): CanvasNodeArtifact {
  const query = useQuery({
    queryKey: ['usage-logs', 'task-artifacts', taskId],
    queryFn: async () =>
      requireServerSuccess(await getTaskArtifacts(taskId as string)),
    enabled: Boolean(taskId),
    retry: false,
    staleTime: 30_000,
  })
  const artifact = query.data?.artifacts.find(
    (item) =>
      item.type === expected && (!artifactKey || item.key === artifactKey)
  )
  return {
    artifact,
    isPending: Boolean(taskId) && query.isPending,
    isError: Boolean(taskId) && query.isError,
  }
}
