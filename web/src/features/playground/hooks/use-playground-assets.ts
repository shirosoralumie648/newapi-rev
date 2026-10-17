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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { deletePlaygroundAttachment } from '../api'
import { deletePlaygroundArtifact } from '../artifact-api'
import {
  listPlaygroundAssets,
  type PlaygroundAssetItem,
  type PlaygroundAssetKind,
} from '../asset-api'
import { playgroundQueryKeys } from '../lib/query-keys'

/**
 * One page of the owner's asset library. The previous page is kept while the
 * next one loads so typing a search term or paging does not flash the list.
 */
export function usePlaygroundAssets(
  userId: number | null,
  kind: PlaygroundAssetKind,
  search: string,
  page: number,
  enabled: boolean
) {
  return useQuery({
    queryKey: playgroundQueryKeys.assets(userId, kind, search, page),
    queryFn: ({ signal }) =>
      listPlaygroundAssets({ kind, search, page }, signal),
    enabled: enabled && userId !== null,
    placeholderData: (previous) => previous,
    meta: { errorToast: false },
  })
}

/**
 * Deletes one library entry through the existing owner-scoped endpoints: an
 * attachment by id and an artifact by its expected revision. The server keeps
 * its own guards, so an in-use attachment stays a server-side refusal even if
 * the local state is stale.
 */
export function useDeletePlaygroundAsset(userId: number | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (asset: PlaygroundAssetItem) => {
      if (asset.kind === 'artifact') {
        const revision = asset.revision
        if (!revision) throw new Error('Missing artifact revision.')
        await deletePlaygroundArtifact(asset.sessionId, asset.id, revision)
        return
      }
      await deletePlaygroundAttachment(asset.sessionId, asset.id)
    },
    meta: { errorToast: false },
    onSuccess: (_result, asset) => {
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.assetsAll(userId),
      })
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.usage(userId),
      })
      if (asset.kind === 'artifact') {
        void queryClient.invalidateQueries({
          queryKey: playgroundQueryKeys.artifactsAll(userId),
        })
      }
    },
  })
}
