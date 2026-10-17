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

import { canvasDocumentSchema } from './lib/canvas-document'
import type { CanvasProjectSummary, CanvasServerProject } from './types'

const CANVAS_ENDPOINT = '/api/playground/canvases'

const canvasProjectSummarySchema = z.object({
  id: z.string().min(1),
  client_id: z.string().optional(),
  title: z.string(),
  node_count: z.number().int().nonnegative(),
  edge_count: z.number().int().nonnegative(),
  document_bytes: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const canvasProjectSchema = canvasProjectSummarySchema.extend({
  document: canvasDocumentSchema,
  unavailable_node_ids: z.array(z.string()).optional(),
})

function mapCanvasSummary(value: unknown): CanvasProjectSummary {
  const project = canvasProjectSummarySchema.parse(value)
  return {
    id: project.id,
    clientId: project.client_id,
    title: project.title,
    nodeCount: project.node_count,
    edgeCount: project.edge_count,
    documentBytes: project.document_bytes,
    revision: project.revision,
    createdAt: project.created_at * 1000,
    updatedAt: project.updated_at * 1000,
  }
}

function mapCanvasProject(value: unknown): CanvasServerProject {
  const project = canvasProjectSchema.parse(value)
  return {
    ...mapCanvasSummary(project),
    document: project.document,
    ...(project.unavailable_node_ids
      ? { unavailableNodeIds: project.unavailable_node_ids }
      : {}),
  }
}

export function canvasProjectUpdatedAt(value: unknown): number | null {
  const project = canvasProjectSummarySchema.safeParse(value)
  return project.success ? project.data.updated_at : null
}

export async function listCanvasProjects(
  signal?: AbortSignal
): Promise<CanvasProjectSummary[]> {
  const response = await api.get(CANVAS_ENDPOINT, {
    params: { p: 1, page_size: 50 },
    signal,
  })
  requireServerSuccess(response.data)
  const data = z
    .object({
      items: z.array(canvasProjectSummarySchema),
      total: z.number().nonnegative(),
    })
    .parse(response.data.data)
  return data.items.map(mapCanvasSummary)
}

export interface CanvasProjectInput {
  clientId?: string
  title?: string
  document: unknown
}

export async function createCanvasProject(
  input: CanvasProjectInput,
  signal?: AbortSignal
): Promise<CanvasServerProject> {
  const response = await api.post(
    CANVAS_ENDPOINT,
    {
      client_id: input.clientId,
      title: input.title,
      document: input.document,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapCanvasProject(response.data.data)
}

export async function getCanvasProject(
  projectId: string,
  signal?: AbortSignal
): Promise<CanvasServerProject> {
  const response = await api.get(
    `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapCanvasProject(response.data.data)
}

export interface CanvasProjectUpdateInput {
  revision: number
  title?: string
  document?: unknown
}

export async function updateCanvasProject(
  projectId: string,
  input: CanvasProjectUpdateInput,
  signal?: AbortSignal
): Promise<CanvasServerProject> {
  const response = await api.patch(
    `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}`,
    {
      revision: input.revision,
      title: input.title,
      document: input.document,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapCanvasProject(response.data.data)
}

export async function deleteCanvasProject(
  projectId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}
