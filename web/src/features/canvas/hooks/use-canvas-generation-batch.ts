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
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

import { PLAYGROUND_GENERATION_BATCH_CONCURRENCY } from '@/features/playground/constants'
import {
  submitImageGeneration,
  submitVideoGeneration,
} from '@/features/playground/generation-api'
import type { GenerationBatchPlan } from '@/features/playground/lib/generation/generation-batch'
import { playgroundQueryKeys } from '@/features/playground/lib/query-keys'
import { isServerErrorCancelled } from '@/lib/server-error-message'

import { settleCanvasWorkflowRunBudget } from '../api'
import type {
  CanvasGenerationCell,
  CanvasGenerationSubmit,
} from '../lib/canvas-generation-run'
import { runGenerationBatch } from '../lib/canvas-generation-run'

export interface CanvasGenerationRunOptions {
  /** Run budget every request of this batch bills inside (BL-03). */
  budgetRunId?: string
  /** Pre-run quota per request id, shown beside each cell. */
  estimates?: Record<string, number>
}

export interface CanvasGenerationBatchState {
  /** The last started plan; a rerun reuses its exact parameters. */
  plan: GenerationBatchPlan | null
  cells: CanvasGenerationCell[]
  running: boolean
  /** Set when the user stopped the batch. */
  stopped: boolean
  /** Set when the run budget could not be settled after the batch. */
  budgetSettleFailed: boolean
  run: (
    plan: GenerationBatchPlan,
    options?: CanvasGenerationRunOptions
  ) => Promise<void>
  rerun: (budgetRunId?: string) => Promise<void>
  stop: () => void
}

/**
 * Client-side orchestration of one media batch. Every cell is an ordinary
 * `/pg/images/generations` or `/pg/videos` request with its own relay
 * pre-charge, group and rate limit; the hook only schedules them with bounded
 * concurrency, keeps an optional BL-03 run budget and records what each cell
 * observed. It never charges quota itself.
 */
export function useCanvasGenerationBatch(): CanvasGenerationBatchState {
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<GenerationBatchPlan | null>(null)
  const [cells, setCells] = useState<CanvasGenerationCell[]>([])
  const [running, setRunning] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [budgetSettleFailed, setBudgetSettleFailed] = useState(false)
  const planRef = useRef<GenerationBatchPlan | null>(null)
  const estimatesRef = useRef<Record<string, number>>({})
  const controllerRef = useRef<AbortController | null>(null)

  const submit: CanvasGenerationSubmit = useCallback(
    async (request, signal, budgetRunId) => {
      if (request.kind === 'image') {
        const outcome = await submitImageGeneration(
          {
            model: request.model,
            prompt: request.prompt,
            group: request.group,
            size: request.size,
            quality: request.quality,
            count: request.count,
            seed: request.seed,
          },
          signal,
          budgetRunId
        )
        if (outcome.kind === 'task') return { taskId: outcome.taskId }
        return { images: outcome.images }
      }
      const taskId = await submitVideoGeneration(
        {
          model: request.model,
          prompt: request.prompt,
          group: request.group,
          size: request.size,
          duration: request.duration,
          seed: request.seed,
        },
        signal,
        budgetRunId
      )
      return taskId ? { taskId } : {}
    },
    []
  )

  const run = useCallback(
    async (
      nextPlan: GenerationBatchPlan,
      options?: CanvasGenerationRunOptions
    ) => {
      if (nextPlan.requests.length === 0) return
      const controller = new AbortController()
      controllerRef.current = controller
      planRef.current = nextPlan
      setPlan(nextPlan)
      setStopped(false)
      setBudgetSettleFailed(false)
      setRunning(true)
      const estimates = options?.estimates ?? {}
      estimatesRef.current = estimates
      setCells(
        nextPlan.requests.map((request) => ({
          request,
          status: 'pending',
          ...(estimates[request.id] !== undefined
            ? { estimatedQuota: estimates[request.id] }
            : {}),
        }))
      )
      try {
        await runGenerationBatch({
          plan: nextPlan,
          concurrency: PLAYGROUND_GENERATION_BATCH_CONCURRENCY,
          submit,
          signal: controller.signal,
          budgetRunId: options?.budgetRunId,
          onCell: (requestId, update) => {
            setCells((current) =>
              current.map((cell) =>
                cell.request.id === requestId ? { ...cell, ...update } : cell
              )
            )
          },
        })
      } finally {
        if (options?.budgetRunId) {
          try {
            await settleCanvasWorkflowRunBudget(options.budgetRunId)
          } catch (error: unknown) {
            if (!isServerErrorCancelled(error)) setBudgetSettleFailed(true)
          }
        }
        controllerRef.current = null
        setRunning(false)
        void queryClient.invalidateQueries({
          queryKey: playgroundQueryKeys.tasksAll(),
        })
      }
    },
    [queryClient, submit]
  )

  const rerun = useCallback(
    async (budgetRunId?: string) => {
      const lastPlan = planRef.current
      if (!lastPlan) return
      await run(lastPlan, {
        ...(budgetRunId ? { budgetRunId } : {}),
        estimates: estimatesRef.current,
      })
    },
    [run]
  )

  const stop = useCallback(() => {
    setStopped(true)
    controllerRef.current?.abort()
  }, [])

  return { plan, cells, running, stopped, budgetSettleFailed, run, rerun, stop }
}
