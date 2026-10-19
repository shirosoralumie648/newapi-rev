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

import { API_ENDPOINTS } from './constants'
import type {
  PlaygroundComparisonCell,
  PlaygroundComparisonCellStatus,
  PlaygroundComparisonRun,
  PlaygroundComparisonRunCreateInput,
  PlaygroundComparisonRunStatus,
  PlaygroundComparisonRunSummary,
  PlaygroundComparisonRunUpdateInput,
  PlaygroundComparisonStrategy,
} from './types'

const comparisonCellSchema = z.object({
  prompt_index: z.number().int().nonnegative(),
  model_index: z.number().int().nonnegative(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'canceled']),
  output: z.string().optional().default(''),
  error: z.string().optional().default(''),
  error_code: z.string().optional().default(''),
  request_id: z.string().optional().default(''),
  prompt_tokens: z.number().int().nonnegative().optional().default(0),
  completion_tokens: z.number().int().nonnegative().optional().default(0),
  total_tokens: z.number().int().nonnegative().optional().default(0),
  latency_ms: z.number().int().nonnegative().optional().default(0),
})

const comparisonRunSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  group: z.string(),
  models: z.array(z.string()),
  prompts: z.array(z.string()),
  results: z.array(comparisonCellSchema),
  status: z.enum(['running', 'completed', 'failed', 'canceled']),
  strategy: z.enum(['serial', 'concurrent']),
  concurrency: z.number().int().nonnegative(),
  estimate_quota: z.number().int().nonnegative(),
  budget_cap: z.number().int().nonnegative(),
  baseline_model: z.string().optional().default(''),
  model_count: z.number().int().nonnegative(),
  prompt_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const comparisonRunSummarySchema = comparisonRunSchema.omit({
  models: true,
  prompts: true,
  results: true,
})

const comparisonRunListSchema = z.object({
  items: z.array(comparisonRunSummarySchema),
})

function mapCell(
  cell: z.output<typeof comparisonCellSchema>
): PlaygroundComparisonCell {
  return {
    promptIndex: cell.prompt_index,
    modelIndex: cell.model_index,
    status: cell.status as PlaygroundComparisonCellStatus,
    output: cell.output,
    error: cell.error,
    errorCode: cell.error_code,
    requestId: cell.request_id,
    promptTokens: cell.prompt_tokens,
    completionTokens: cell.completion_tokens,
    totalTokens: cell.total_tokens,
    latencyMs: cell.latency_ms,
  }
}

function mapRun(
  run: z.output<typeof comparisonRunSchema>
): PlaygroundComparisonRun {
  return {
    id: run.id,
    title: run.title,
    group: run.group,
    models: run.models,
    prompts: run.prompts,
    results: run.results.map(mapCell),
    status: run.status as PlaygroundComparisonRunStatus,
    strategy: run.strategy as PlaygroundComparisonStrategy,
    concurrency: run.concurrency,
    estimateQuota: run.estimate_quota,
    budgetCap: run.budget_cap,
    baselineModel: run.baseline_model,
    modelCount: run.model_count,
    promptCount: run.prompt_count,
    byteSize: run.byte_size,
    revision: run.revision,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  }
}

function mapSummary(
  run: z.output<typeof comparisonRunSummarySchema>
): PlaygroundComparisonRunSummary {
  return {
    id: run.id,
    title: run.title,
    group: run.group,
    status: run.status as PlaygroundComparisonRunStatus,
    strategy: run.strategy as PlaygroundComparisonStrategy,
    concurrency: run.concurrency,
    estimateQuota: run.estimate_quota,
    budgetCap: run.budget_cap,
    baselineModel: run.baseline_model,
    modelCount: run.model_count,
    promptCount: run.prompt_count,
    byteSize: run.byte_size,
    revision: run.revision,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  }
}

/**
 * The caller's newest compare runs. The list projection never carries a stored
 * matrix, so loading history stays cheap however large one snapshot is.
 */
export async function listPlaygroundComparisonRuns(
  signal?: AbortSignal
): Promise<PlaygroundComparisonRunSummary[]> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_COMPARISONS, {
    signal,
  })
  requireServerSuccess(response.data)
  const data = comparisonRunListSchema.parse(response.data.data)
  return data.items.map(mapSummary)
}

/**
 * Stores one immutable matrix and returns its pending cells. The server
 * validates the models, prompts and budgets again; nothing is sent to a model
 * before the browser starts the cells.
 */
export async function createPlaygroundComparisonRun(
  input: PlaygroundComparisonRunCreateInput,
  signal?: AbortSignal
): Promise<PlaygroundComparisonRun> {
  const response = await api.post(
    API_ENDPOINTS.PLAYGROUND_COMPARISONS,
    {
      title: input.title ?? '',
      group: input.group,
      models: input.models,
      prompts: input.prompts,
      strategy: input.strategy,
      concurrency: input.concurrency,
      estimate_quota: input.estimateQuota,
      budget_cap: input.budgetCap,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapRun(comparisonRunSchema.parse(response.data.data))
}

/** Reads one owner-scoped run with its matrix. */
export async function getPlaygroundComparisonRun(
  runId: string,
  signal?: AbortSignal
): Promise<PlaygroundComparisonRun> {
  const response = await api.get(
    `${API_ENDPOINTS.PLAYGROUND_COMPARISONS}/${encodeURIComponent(runId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapRun(comparisonRunSchema.parse(response.data.data))
}

/**
 * Replaces the result snapshot of one run under the revision the caller read.
 * A mismatch is a server conflict instead of a silent overwrite.
 */
export async function updatePlaygroundComparisonRun(
  runId: string,
  input: PlaygroundComparisonRunUpdateInput,
  signal?: AbortSignal
): Promise<PlaygroundComparisonRun> {
  const response = await api.patch(
    `${API_ENDPOINTS.PLAYGROUND_COMPARISONS}/${encodeURIComponent(runId)}`,
    {
      revision: input.revision,
      status: input.status,
      results: input.results.map((cell) => ({
        prompt_index: cell.promptIndex,
        model_index: cell.modelIndex,
        status: cell.status,
        output: cell.output,
        error: cell.error,
        error_code: cell.errorCode,
        request_id: cell.requestId,
        prompt_tokens: cell.promptTokens,
        completion_tokens: cell.completionTokens,
        total_tokens: cell.totalTokens,
        latency_ms: cell.latencyMs,
      })),
      baseline_model: input.baselineModel,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapRun(comparisonRunSchema.parse(response.data.data))
}

/** Removes one run and releases its account counters. */
export async function deletePlaygroundComparisonRun(
  runId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_COMPARISONS}/${encodeURIComponent(runId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}
