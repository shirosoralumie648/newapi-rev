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

export const playgroundArtifactKindSchema = z.enum([
  'markdown',
  'code',
  'html',
  'svg',
])
export type PlaygroundArtifactKind = z.infer<
  typeof playgroundArtifactKindSchema
>

const artifactSummarySchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  kind: playgroundArtifactKindSchema,
  revision: z.number().int().positive(),
  current_version_id: z.string().min(1),
  title: z.string(),
  language: z.string(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const artifactVersionSchema = z.object({
  id: z.string().min(1),
  artifact_id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  language: z.string(),
  content: z.string(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  restored_from_version_id: z.string().optional(),
})

const artifactResultSchema = z.object({
  artifact: artifactSummarySchema,
  version: artifactVersionSchema,
})

const artifactPageSchema = z.object({
  items: z.array(artifactSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
})

const versionPageSchema = z.object({
  items: z.array(artifactVersionSchema.omit({ content: true })),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
})

export type PlaygroundArtifactSummary = z.infer<typeof artifactSummarySchema>
export type PlaygroundArtifactVersion = z.infer<typeof artifactVersionSchema>
export type PlaygroundArtifactVersionMetadata = z.infer<
  typeof versionPageSchema
>['items'][number]
export type PlaygroundArtifactResult = z.infer<typeof artifactResultSchema>
export type PlaygroundArtifactPage = z.infer<typeof artifactPageSchema>
export type PlaygroundArtifactVersionPage = z.infer<typeof versionPageSchema>

export interface PlaygroundArtifactSource {
  message_key: string
  version_id: string
  message_revision: number
  content_hash: string
  code_block_index?: number
}

export interface CreatePlaygroundArtifactRequest {
  request_id: string
  kind: PlaygroundArtifactKind
  title: string
  language: string
  content: string
  source: PlaygroundArtifactSource
}

export interface SavePlaygroundArtifactRequest {
  request_id: string
  expected_revision: number
  title: string
  language: string
  content: string
}

export interface RestorePlaygroundArtifactRequest {
  request_id: string
  expected_revision: number
  version_id: string
}

function artifactPath(sessionId: string): string {
  return `/api/playground/sessions/${encodeURIComponent(sessionId)}/artifacts`
}

export async function listPlaygroundArtifacts(
  sessionId: string,
  page = 1,
  signal?: AbortSignal
): Promise<PlaygroundArtifactPage> {
  const response = await api.get(artifactPath(sessionId), {
    params: { p: page, page_size: 50 },
    signal,
  })
  requireServerSuccess(response.data)
  return artifactPageSchema.parse(response.data.data)
}

export async function createPlaygroundArtifact(
  sessionId: string,
  request: CreatePlaygroundArtifactRequest,
  signal?: AbortSignal
): Promise<PlaygroundArtifactResult> {
  const response = await api.post(artifactPath(sessionId), request, { signal })
  requireServerSuccess(response.data)
  return artifactResultSchema.parse(response.data.data)
}

export async function getPlaygroundArtifact(
  sessionId: string,
  artifactId: string,
  versionId?: string,
  signal?: AbortSignal
): Promise<PlaygroundArtifactResult> {
  const suffix = versionId ? `/versions/${encodeURIComponent(versionId)}` : ''
  const response = await api.get(
    `${artifactPath(sessionId)}/${encodeURIComponent(artifactId)}${suffix}`,
    { signal }
  )
  requireServerSuccess(response.data)
  return artifactResultSchema.parse(response.data.data)
}

export async function listPlaygroundArtifactVersions(
  sessionId: string,
  artifactId: string,
  page = 1,
  signal?: AbortSignal
): Promise<PlaygroundArtifactVersionPage> {
  const response = await api.get(
    `${artifactPath(sessionId)}/${encodeURIComponent(artifactId)}/versions`,
    {
      params: { p: page, page_size: 50 },
      signal,
    }
  )
  requireServerSuccess(response.data)
  return versionPageSchema.parse(response.data.data)
}

export async function savePlaygroundArtifactVersion(
  sessionId: string,
  artifactId: string,
  request: SavePlaygroundArtifactRequest,
  signal?: AbortSignal
): Promise<PlaygroundArtifactResult> {
  const response = await api.post(
    `${artifactPath(sessionId)}/${encodeURIComponent(artifactId)}/versions`,
    request,
    { signal }
  )
  requireServerSuccess(response.data)
  return artifactResultSchema.parse(response.data.data)
}

export async function restorePlaygroundArtifactVersion(
  sessionId: string,
  artifactId: string,
  request: RestorePlaygroundArtifactRequest,
  signal?: AbortSignal
): Promise<PlaygroundArtifactResult> {
  const response = await api.post(
    `${artifactPath(sessionId)}/${encodeURIComponent(artifactId)}/restore`,
    request,
    { signal }
  )
  requireServerSuccess(response.data)
  return artifactResultSchema.parse(response.data.data)
}

export async function deletePlaygroundArtifact(
  sessionId: string,
  artifactId: string,
  expectedRevision: number,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${artifactPath(sessionId)}/${encodeURIComponent(artifactId)}`,
    {
      params: { expected_revision: expectedRevision },
      signal,
    }
  )
  requireServerSuccess(response.data)
}
