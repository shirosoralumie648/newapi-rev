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
import type { PlaygroundImageResult } from '@/features/playground/generation-api'
import { estimateTextTokens } from '@/features/playground/lib/context/playground-context'
import type {
  GenerationBatchPlan,
  GenerationBatchRequest,
} from '@/features/playground/lib/generation/generation-batch'

import type { CanvasWorkflowEstimateStepInput } from './canvas-workflow-budget'
import { CANVAS_WORKFLOW_BUDGET_TOKEN_MAX } from './canvas-workflow-budget'

/** Lifecycle of one cell of a media batch. */
export type CanvasGenerationCellStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'

/** One request of a media batch and everything observed while it ran. */
export interface CanvasGenerationCell {
  request: GenerationBatchRequest
  status: CanvasGenerationCellStatus
  /** Wall-clock duration of the request, once it finished. */
  elapsedMs?: number
  /** Inline images when the relay answered synchronously. */
  images?: PlaygroundImageResult[]
  /** Durable task id when the model runs through a task plugin. */
  taskId?: string
  /** Server queue entry id when the concurrency budget accepted the request. */
  queuedEntryId?: string
  /** Already translated failure text, when the cell failed. */
  error?: string
  /** Estimate returned by the pre-run pricing call, when one ran. */
  estimatedQuota?: number
}

/** What one submitted request resolved to, for the runner to record. */
export interface CanvasGenerationSubmitResult {
  images?: PlaygroundImageResult[]
  taskId?: string
  queuedEntryId?: string
}

/** How the batch runner submits one request; injected for tests. */
export type CanvasGenerationSubmit = (
  request: GenerationBatchRequest,
  signal: AbortSignal,
  budgetRunId?: string
) => Promise<CanvasGenerationSubmitResult>

/**
 * Error codes that mean every later media request would fail too, so the batch
 * stops instead of burning the account's remaining quota.
 */
const GENERATION_STOP_ERROR_CODES = new Set([
  'workflow_budget_exceeded',
  'insufficient_user_quota',
  'pre_consume_token_quota_failed',
  'token_period_quota_exhausted',
])

/** The stable relay error code of a failed request, when one was returned. */
export function generationErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const source = error as {
    response?: { data?: { error?: { code?: unknown }; code?: unknown } }
  }
  const nested = source.response?.data?.error?.code
  if (typeof nested === 'string') return nested.trim()
  const topLevel = source.response?.data?.code
  if (typeof topLevel === 'string') return topLevel.trim()
  return ''
}

/** Whether a failed cell means the rest of the batch should stop. */
export function generationShouldStopAfterError(code: string): boolean {
  return GENERATION_STOP_ERROR_CODES.has(code)
}

/**
 * Prices one planned media batch through the BL-03 estimate endpoint: one
 * synthetic step per request, in run order. Prompt tokens are estimated from
 * the prompt the request already carries; video steps stay marked approximate
 * by the server because its usage-profile ratios apply at submission.
 */
export function generationPlanEstimateSteps(
  plan: GenerationBatchPlan
): CanvasWorkflowEstimateStepInput[] {
  return plan.requests.map((request) => ({
    nodeId: request.id,
    kind: request.kind,
    model: request.model,
    tokens: Math.min(
      estimateTextTokens(request.prompt),
      CANVAS_WORKFLOW_BUDGET_TOKEN_MAX
    ),
    group: request.group,
    ...(request.count ? { count: request.count } : {}),
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
  }))
}

/**
 * Runs a media batch with bounded concurrency. Every worker claims the next
 * unclaimed request, so a slow request never blocks the queue; stopping aborts
 * in-flight requests and skips the rest. The caller owns the store and renders
 * the cells from the updates reported here.
 */
export async function runGenerationBatch(input: {
  plan: GenerationBatchPlan
  concurrency: number
  submit: CanvasGenerationSubmit
  signal: AbortSignal
  budgetRunId?: string
  onCell: (
    requestId: string,
    update: Partial<Omit<CanvasGenerationCell, 'request'>>
  ) => void
}): Promise<void> {
  let nextIndex = 0
  let stopped = input.signal.aborted
  const workerCount = Math.max(
    1,
    Math.min(Math.trunc(input.concurrency), input.plan.requests.length)
  )
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      const request = input.plan.requests[index]
      if (!request) return
      if (stopped || input.signal.aborted) {
        input.onCell(request.id, { status: 'skipped' })
        continue
      }
      const startedAt = Date.now()
      input.onCell(request.id, { status: 'running' })
      try {
        const result = await input.submit(
          request,
          input.signal,
          input.budgetRunId
        )
        input.onCell(request.id, {
          status: 'succeeded',
          elapsedMs: Date.now() - startedAt,
          ...(result.images ? { images: result.images } : {}),
          ...(result.taskId ? { taskId: result.taskId } : {}),
          ...(result.queuedEntryId
            ? { queuedEntryId: result.queuedEntryId }
            : {}),
        })
      } catch (error) {
        if (input.signal.aborted) {
          input.onCell(request.id, { status: 'skipped' })
          continue
        }
        const code = generationErrorCode(error)
        if (generationShouldStopAfterError(code)) stopped = true
        input.onCell(request.id, {
          status: 'failed',
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })
  await Promise.all(workers)
}
