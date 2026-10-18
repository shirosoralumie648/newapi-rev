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
import type { AxiosResponse } from 'axios'
import { z } from 'zod'

import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import { canvasDocumentSchema } from './lib/canvas-document'
import type { CanvasWorkflowEstimateStepInput } from './lib/canvas-workflow-budget'
import type {
  CanvasProjectSummary,
  CanvasServerProject,
  CanvasSnapshotSummary,
} from './types'

const CANVAS_ENDPOINT = '/api/playground/canvases'
// One workflow run may open a budget cap before its steps start and settle it
// when they stop (BL-03).
const WORKFLOW_ENDPOINT = '/api/playground/workflows'

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

const canvasSnapshotSchema = z.object({
  id: z.string().min(1),
  canvas_id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  node_count: z.number().int().nonnegative(),
  edge_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
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

/** Restores a canvas the account previously moved to the trash. */
export async function restoreCanvasProject(
  projectId: string,
  signal?: AbortSignal
): Promise<CanvasServerProject> {
  const response = await api.post(
    `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}/restore`,
    undefined,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapCanvasProject(response.data.data)
}

/**
 * The canvas history, newest first. The server stores snapshot bodies in the
 * object store and answers with metadata only, so the list never carries a
 * document.
 */
export async function listCanvasSnapshots(
  projectId: string,
  signal?: AbortSignal
): Promise<CanvasSnapshotSummary[]> {
  const response = await api.get(
    `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}/snapshots`,
    { params: { p: 1, page_size: 50 }, signal }
  )
  requireServerSuccess(response.data)
  const data = z
    .object({
      items: z.array(canvasSnapshotSchema),
      total: z.number().nonnegative(),
    })
    .parse(response.data.data)
  return data.items.map((snapshot) => ({
    id: snapshot.id,
    canvasId: snapshot.canvas_id,
    revision: snapshot.revision,
    nodeCount: snapshot.node_count,
    edgeCount: snapshot.edge_count,
    byteSize: snapshot.byte_size,
    createdAt: snapshot.created_at * 1000,
  }))
}

/**
 * Restores one stored snapshot as the canvas document. `revision` is the
 * compare-and-swap token of the replace, and the answered project carries the
 * restored document and the new revision.
 */
export async function restoreCanvasSnapshot(
  projectId: string,
  snapshotId: string,
  revision: number,
  signal?: AbortSignal
): Promise<CanvasServerProject> {
  const response = await api.post(
    `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    { revision },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapCanvasProject(response.data.data)
}

export interface CanvasArchiveDownload {
  blob: Blob
  filename: string
}

/**
 * Reads the filename the export endpoint suggests. Non-ASCII titles arrive
 * RFC 5987 encoded, so the extended form wins over the quoted one.
 */
function canvasArchiveFilename(disposition: unknown, fallback: string): string {
  if (typeof disposition !== 'string') return fallback
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim())
    } catch {
      return fallback
    }
  }
  const quoted = /filename="?([^";]+)"?/i.exec(disposition)
  return quoted?.[1]?.trim() || fallback
}

/**
 * Downloads the archive of one canvas. `nodeIds` restricts the archive to the
 * picked nodes, so a selection carries only the resources those nodes
 * reference. The answer is a streamed zip built by the server from the
 * owner-checked attachment rows.
 */
export async function exportCanvasArchive(
  projectId: string,
  nodeIds?: string[],
  signal?: AbortSignal
): Promise<CanvasArchiveDownload> {
  let response: AxiosResponse<Blob>
  try {
    response = await api.get<Blob>(
      `${CANVAS_ENDPOINT}/${encodeURIComponent(projectId)}/export`,
      {
        params: nodeIds?.length ? { nodes: nodeIds.join(',') } : undefined,
        responseType: 'blob',
        signal,
      }
    )
  } catch (error) {
    // A failed download wraps its JSON error body in a Blob; decode it so the
    // shared error helpers can still read the server message.
    const failed = (error as { response?: { data?: unknown } }).response
    if (failed && failed.data instanceof Blob) {
      try {
        failed.data = JSON.parse(await failed.data.text())
      } catch {
        /* not a JSON error payload; report the original failure */
      }
    }
    throw error
  }
  return {
    blob: response.data,
    filename: canvasArchiveFilename(
      response.headers['content-disposition'],
      'canvas.zip'
    ),
  }
}

export interface CanvasArchiveImportResult {
  project: CanvasServerProject
  resourcesImported: number
  resourcesMissing: number
  referencesDropped: number
}

const canvasArchiveImportSchema = z.object({
  project: canvasProjectSchema,
  resources_imported: z.number().int().nonnegative(),
  resources_missing: z.number().int().nonnegative(),
  references_dropped: z.number().int().nonnegative(),
})

/**
 * Restores an exported archive as a new canvas. The server re-uploads the
 * carried resources into the signed-in account and rewrites the node
 * references, so the returned project opens like any other; a resource the
 * archive lost is counted instead of failing the import.
 */
export async function importCanvasArchive(
  file: File,
  signal?: AbortSignal
): Promise<CanvasArchiveImportResult> {
  const form = new FormData()
  form.append('file', file)
  const response = await api.post(`${CANVAS_ENDPOINT}/import`, form, { signal })
  requireServerSuccess(response.data)
  const data = canvasArchiveImportSchema.parse(response.data.data)
  return {
    project: mapCanvasProject(data.project),
    resourcesImported: data.resources_imported,
    resourcesMissing: data.resources_missing,
    referencesDropped: data.references_dropped,
  }
}

const workflowEstimateStepSchema = z.object({
  node_id: z.string(),
  quota: z.number().int().nonnegative(),
  available: z.boolean(),
  approximate: z.boolean(),
})

const workflowEstimateSchema = z.object({
  steps: z.array(workflowEstimateStepSchema),
  total_quota: z.number().int().nonnegative(),
  available: z.boolean(),
})

const workflowRunSchema = z.object({
  run_id: z.string().min(1),
  cap: z.number().int().nonnegative(),
  spent: z.number().int(),
  remaining: z.number().int(),
  status: z.string().optional(),
})

/** One priced step of a planned run. */
export interface CanvasWorkflowEstimateStep {
  nodeId: string
  /** Pre-charge quota of the step; an unavailable step carries zero. */
  quota: number
  /** False when the server could not price the step (no configured price). */
  available: boolean
  /** True for a task step whose adaptor ratios only apply at submission. */
  approximate: boolean
}

export interface CanvasWorkflowRunEstimate {
  steps: CanvasWorkflowEstimateStep[]
  totalQuota: number
  /** False when at least one step could not be priced. */
  available: boolean
}

/** One workflow run budget: cap, what the steps spent and what is left. */
export interface CanvasWorkflowRunBudget {
  runId: string
  cap: number
  spent: number
  remaining: number
  status: string
}

function mapWorkflowRun(
  value: z.infer<typeof workflowRunSchema>
): CanvasWorkflowRunBudget {
  return {
    runId: value.run_id,
    cap: value.cap,
    spent: value.spent,
    remaining: value.remaining,
    status: value.status ?? '',
  }
}

/**
 * Prices the steps of a planned workflow run. The endpoint mirrors the
 * pre-charge of the real relay paths, so the returned sum is what starting the
 * run reserves; a step it cannot price is reported as unavailable instead of
 * failing the whole estimate.
 */
export async function estimateCanvasWorkflowRun(
  group: string,
  steps: CanvasWorkflowEstimateStepInput[],
  signal?: AbortSignal
): Promise<CanvasWorkflowRunEstimate> {
  const response = await api.post(
    `${WORKFLOW_ENDPOINT}/estimate`,
    {
      group,
      steps: steps.map((step) => ({
        node_id: step.nodeId,
        kind: step.kind,
        model: step.model,
        tokens: step.tokens,
        group: step.group,
        ...(step.count ? { count: step.count } : {}),
        ...(step.size ? { size: step.size } : {}),
        ...(step.quality ? { quality: step.quality } : {}),
      })),
    },
    { signal }
  )
  requireServerSuccess(response.data)
  const data = workflowEstimateSchema.parse(response.data.data)
  return {
    steps: data.steps.map((step) => ({
      nodeId: step.node_id,
      quota: step.quota,
      available: step.available,
      approximate: step.approximate,
    })),
    totalQuota: data.total_quota,
    available: data.available,
  }
}

/**
 * Opens one run budget: the cap is reserved from the wallet, and every step of
 * the run then allocates inside it. Settling returns what the steps did not
 * spend.
 */
export async function createCanvasWorkflowRunBudget(
  cap: number,
  signal?: AbortSignal
): Promise<CanvasWorkflowRunBudget> {
  const response = await api.post(
    `${WORKFLOW_ENDPOINT}/runs`,
    { cap },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapWorkflowRun(workflowRunSchema.parse(response.data.data))
}

/**
 * Settles the budget of a stopped run and returns the summary. The call is
 * idempotent, so a retry after a lost response reports the recorded outcome.
 */
export async function settleCanvasWorkflowRunBudget(
  runId: string,
  signal?: AbortSignal
): Promise<CanvasWorkflowRunBudget> {
  const response = await api.post(
    `${WORKFLOW_ENDPOINT}/runs/${encodeURIComponent(runId)}/settle`,
    {},
    { signal }
  )
  requireServerSuccess(response.data)
  return mapWorkflowRun(workflowRunSchema.parse(response.data.data))
}
