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
import { z } from 'zod'

import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  API_ENDPOINTS,
  PLAYGROUND_ASSET_PAGE_SIZE,
  PLAYGROUND_ASSET_SEARCH_MAX_LENGTH,
} from './constants'

/**
 * The asset library browses the two owner-scoped resources that have no other
 * listing entry: Playground attachments and saved artifacts. Generation
 * results are durable task rows and stay behind the owner-scoped task
 * endpoints, so they are not a server-side kind.
 */
export const playgroundAssetKindSchema = z.enum(['attachment', 'artifact'])
export type PlaygroundAssetKind = z.infer<typeof playgroundAssetKindSchema>

const playgroundAssetItemSchema = z.object({
  kind: playgroundAssetKindSchema,
  id: z.string().min(1),
  session_id: z.string().min(1),
  title: z.string(),
  media_type: z.string().optional(),
  language: z.string().optional(),
  byte_size: z.number().int().nonnegative().optional(),
  revision: z.number().int().positive().optional(),
  in_use: z.boolean(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const playgroundAssetPageSchema = z.object({
  items: z.array(playgroundAssetItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
})

/**
 * One library entry. Metadata only: the stored bytes and artifact bodies stay
 * behind their owner-scoped content endpoints, and every action (preview,
 * send, delete) re-verifies ownership on the server.
 */
export interface PlaygroundAssetItem {
  kind: PlaygroundAssetKind
  id: string
  sessionId: string
  title: string
  /** Set for attachments. */
  mediaType?: string
  /** Set for artifacts. */
  language?: string
  byteSize?: number
  /** The artifact revision the delete endpoint expects. */
  revision?: number
  /** The server refuses to delete an attachment a message or canvas uses. */
  inUse: boolean
  createdAt: number
  updatedAt: number
}

export interface PlaygroundAssetPage {
  items: PlaygroundAssetItem[]
  total: number
  page: number
}

export interface PlaygroundAssetQuery {
  kind: PlaygroundAssetKind
  search?: string
  page?: number
}

function mapPlaygroundAssetItem(
  item: z.output<typeof playgroundAssetItemSchema>
): PlaygroundAssetItem {
  return {
    kind: item.kind,
    id: item.id,
    sessionId: item.session_id,
    title: item.title,
    mediaType: item.media_type,
    language: item.language,
    byteSize: item.byte_size,
    revision: item.revision,
    inUse: item.in_use,
    createdAt: item.created_at * 1000,
    updatedAt: item.updated_at * 1000,
  }
}

/** Lists one page of the caller's library; the server enforces the owner scope. */
export async function listPlaygroundAssets(
  query: PlaygroundAssetQuery,
  signal?: AbortSignal
): Promise<PlaygroundAssetPage> {
  const search =
    query.search?.trim().slice(0, PLAYGROUND_ASSET_SEARCH_MAX_LENGTH) ?? ''
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_ASSETS, {
    params: {
      kind: query.kind,
      ...(search ? { search } : {}),
      p: query.page ?? 1,
      page_size: PLAYGROUND_ASSET_PAGE_SIZE,
    },
    signal,
  })
  requireServerSuccess(response.data)
  const page = playgroundAssetPageSchema.parse(response.data.data)
  return {
    items: page.items.map(mapPlaygroundAssetItem),
    total: page.total,
    page: page.page,
  }
}
