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
import { useCallback, useRef, useState } from 'react'

import {
  createCanvasWorkflowRunBudget,
  settleCanvasWorkflowRunBudget,
} from '@/features/canvas/api'
import {
  isServerErrorCancelled,
  getServerErrorMessage,
} from '@/lib/server-error-message'

import { sendChatCompletion } from '../api'
import {
  createPlaygroundComparisonRun,
  deletePlaygroundComparisonRun,
  updatePlaygroundComparisonRun,
} from '../comparison-api'
import { PLAYGROUND_COMPARISON_MESSAGES } from '../constants'
import { normalizeMessageRequestId, toMessageUsage } from '../lib'
import {
  comparisonCellKey,
  comparisonChoiceOutput,
  comparisonErrorCode,
  comparisonShouldStopAfterError,
  comparisonStoredError,
  comparisonStoredOutput,
} from '../lib/comparison/playground-comparison'
import { parseRequestErrorDetails } from '../lib/streaming/request-error-utils'
import type {
  PlaygroundComparisonCell,
  PlaygroundComparisonRun,
  PlaygroundComparisonRunStatus,
  PlaygroundComparisonStrategy,
} from '../types'

export interface StartPlaygroundComparisonRunInput {
  group: string
  models: string[]
  prompts: string[]
  strategy: PlaygroundComparisonStrategy
  concurrency: number
  estimateQuota: number
  budgetCap: number
  title?: string
}

export interface PlaygroundComparisonRunner {
  run: PlaygroundComparisonRun | null
  isRunning: boolean
  /** Matrix key of the cell currently being retried, when any. */
  retryingKey: string | null
  /** Current failure or stop explanation, already an English i18n key. */
  message: string
  start: (input: StartPlaygroundComparisonRunInput) => Promise<boolean>
  stop: () => void
  retryCell: (cell: PlaygroundComparisonCell) => Promise<void>
  setBaseline: (model: string) => Promise<void>
  load: (run: PlaygroundComparisonRun) => void
  clear: () => void
  remove: (runId: string) => Promise<boolean>
}

const QUOTA_STOP_CODES = new Set([
  'insufficient_user_quota',
  'pre_consume_token_quota_failed',
  'token_period_quota_exhausted',
])

/**
 * Client-side orchestration of one compare run. Every cell is an ordinary
 * non-streaming `/pg/chat/completions` request with its own pre-charge,
 * settlement, group and rate limit; the hook only schedules them, records the
 * bounded results through the compare-run API and keeps a run budget when the
 * user set one. It never charges quota itself.
 */
export function usePlaygroundComparisonRunner(): PlaygroundComparisonRunner {
  const [run, setRun] = useState<PlaygroundComparisonRun | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [retryingKey, setRetryingKey] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const runRef = useRef<PlaygroundComparisonRun | null>(null)
  const runningRef = useRef(false)
  const stoppingRef = useRef(false)
  const stopCodeRef = useRef('')
  const controllerRef = useRef<AbortController | null>(null)
  const persistChainRef = useRef<Promise<void>>(Promise.resolve())

  const commitRun = useCallback((next: PlaygroundComparisonRun | null) => {
    runRef.current = next
    setRun(next)
  }, [])

  const patchCell = useCallback(
    (runId: string, key: string, patch: Partial<PlaygroundComparisonCell>) => {
      const current = runRef.current
      if (!current || current.id !== runId) return
      commitRun({
        ...current,
        results: current.results.map((cell) =>
          comparisonCellKey(cell) === key ? { ...cell, ...patch } : cell
        ),
      })
    },
    [commitRun]
  )

  /**
   * Persists the current snapshot through the update endpoint. Calls are
   * chained so two writers never race on the same revision; a newer local
   * snapshot is always the one an enqueued write reads. A server conflict
   * stops the whole run because another tab owns the stored revision.
   */
  const persistRun = useCallback(
    (statusOverride?: PlaygroundComparisonRunStatus): Promise<void> => {
      const snapshot = runRef.current
      if (!snapshot) return Promise.resolve()
      const task = persistChainRef.current.then(async () => {
        const latest = runRef.current
        if (!latest || latest.id !== snapshot.id) return
        try {
          const saved = await updatePlaygroundComparisonRun(latest.id, {
            revision: latest.revision,
            status: statusOverride ?? latest.status,
            results: latest.results,
            baselineModel: latest.baselineModel,
          })
          const stillCurrent = runRef.current
          if (!stillCurrent || stillCurrent.id !== saved.id) return
          commitRun({
            ...stillCurrent,
            revision: saved.revision,
            byteSize: saved.byteSize,
            updatedAt: saved.updatedAt,
          })
        } catch (error: unknown) {
          if (isServerErrorCancelled(error)) return
          setMessage(
            getServerErrorMessage(
              error,
              PLAYGROUND_COMPARISON_MESSAGES.SAVE_FAILED
            )
          )
          if (comparisonErrorCode(error) === 'PLAYGROUND_COMPARISON_CONFLICT') {
            stopCodeRef.current = 'PLAYGROUND_COMPARISON_CONFLICT'
            stoppingRef.current = true
            controllerRef.current?.abort()
          }
        }
      })
      persistChainRef.current = task
      return task
    },
    [commitRun]
  )

  const runOneCell = useCallback(
    async (
      runId: string,
      cell: PlaygroundComparisonCell,
      budgetRunId: string | undefined,
      signal: AbortSignal
    ) => {
      const current = runRef.current
      if (!current || current.id !== runId) return
      const key = comparisonCellKey(cell)
      patchCell(runId, key, { status: 'running', error: '', errorCode: '' })
      const prompt = current.prompts[cell.promptIndex] ?? ''
      const model = current.models[cell.modelIndex] ?? ''
      const startedAt = performance.now()
      try {
        const result = await sendChatCompletion(
          {
            model,
            group: current.group,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          },
          signal,
          budgetRunId
        )
        const output = comparisonChoiceOutput(result.response)
        if (output === null) {
          throw new Error(PLAYGROUND_COMPARISON_MESSAGES.NO_CHOICE)
        }
        const usage = toMessageUsage(result.response.usage)
        patchCell(runId, key, {
          status: 'succeeded',
          output: comparisonStoredOutput(output),
          error: '',
          errorCode: '',
          requestId: normalizeMessageRequestId(result.requestId) ?? '',
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          latencyMs: Math.round(performance.now() - startedAt),
        })
      } catch (error: unknown) {
        const latencyMs = Math.round(performance.now() - startedAt)
        if (isServerErrorCancelled(error) || signal.aborted) {
          patchCell(runId, key, { status: 'canceled', latencyMs })
        } else {
          const details = parseRequestErrorDetails(error)
          const code = comparisonErrorCode(error)
          patchCell(runId, key, {
            status: 'failed',
            error: comparisonStoredError(details.errorMessage),
            errorCode: code,
            latencyMs,
          })
          if (comparisonShouldStopAfterError(code)) {
            stopCodeRef.current = code
          }
        }
      }
      void persistRun()
    },
    [patchCell, persistRun]
  )

  const executeRun = useCallback(
    async (
      created: PlaygroundComparisonRun,
      budgetRunId: string | undefined,
      controller: AbortController
    ) => {
      const cells = [...created.results].sort(
        (left, right) =>
          left.promptIndex - right.promptIndex ||
          left.modelIndex - right.modelIndex
      )
      let nextIndex = 0
      const concurrency =
        created.strategy === 'serial'
          ? 1
          : Math.max(1, Math.min(created.concurrency, cells.length))
      const worker = async () => {
        for (;;) {
          if (stoppingRef.current || stopCodeRef.current) return
          const index = nextIndex
          nextIndex++
          if (index >= cells.length) return
          await runOneCell(
            created.id,
            cells[index],
            budgetRunId,
            controller.signal
          )
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()))

      const current = runRef.current
      if (!current || current.id !== created.id) return
      const finalStatus: PlaygroundComparisonRunStatus = stoppingRef.current
        ? 'canceled'
        : stopCodeRef.current
          ? 'failed'
          : 'completed'
      commitRun({
        ...current,
        status: finalStatus,
        results: current.results.map((cell) =>
          cell.status === 'pending' || cell.status === 'running'
            ? { ...cell, status: 'canceled' }
            : cell
        ),
      })
      await persistChainRef.current
      await persistRun(finalStatus)

      if (stopCodeRef.current === 'workflow_budget_exceeded') {
        setMessage(PLAYGROUND_COMPARISON_MESSAGES.BUDGET_EXCEEDED)
      } else if (QUOTA_STOP_CODES.has(stopCodeRef.current)) {
        setMessage(PLAYGROUND_COMPARISON_MESSAGES.QUOTA_EXCEEDED)
      }
    },
    [commitRun, persistRun, runOneCell]
  )

  const settleBudget = useCallback(async (budgetRunId: string) => {
    try {
      await settleCanvasWorkflowRunBudget(budgetRunId)
    } catch (error: unknown) {
      if (isServerErrorCancelled(error)) return
      setMessage(
        (current) => current || PLAYGROUND_COMPARISON_MESSAGES.SETTLE_FAILED
      )
    }
  }, [])

  const start = useCallback(
    async (input: StartPlaygroundComparisonRunInput): Promise<boolean> => {
      if (runningRef.current) return false
      stoppingRef.current = false
      stopCodeRef.current = ''
      setMessage('')
      const controller = new AbortController()
      controllerRef.current = controller
      runningRef.current = true
      setIsRunning(true)

      let budgetRunId: string | undefined
      try {
        if (input.budgetCap > 0) {
          const budget = await createCanvasWorkflowRunBudget(input.budgetCap)
          budgetRunId = budget.runId
        }
        const created = await createPlaygroundComparisonRun({
          title: input.title,
          group: input.group,
          models: input.models,
          prompts: input.prompts,
          strategy: input.strategy,
          concurrency: input.concurrency,
          estimateQuota: input.estimateQuota,
          budgetCap: input.budgetCap,
        })
        commitRun(created)
        await executeRun(created, budgetRunId, controller)
      } catch (error: unknown) {
        setMessage(
          getServerErrorMessage(
            error,
            PLAYGROUND_COMPARISON_MESSAGES.START_FAILED
          )
        )
        if (budgetRunId) {
          await settleBudget(budgetRunId)
        }
        runningRef.current = false
        setIsRunning(false)
        if (controllerRef.current === controller) {
          controllerRef.current = null
        }
        return false
      }

      if (budgetRunId) {
        await settleBudget(budgetRunId)
      }
      if (controllerRef.current === controller) {
        controllerRef.current = null
      }
      runningRef.current = false
      setIsRunning(false)
      return true
    },
    [commitRun, executeRun, settleBudget]
  )

  const stop = useCallback(() => {
    if (!runningRef.current) return
    stoppingRef.current = true
    controllerRef.current?.abort()
    const current = runRef.current
    if (current) {
      commitRun({
        ...current,
        status: 'canceled',
        results: current.results.map((cell) =>
          cell.status === 'pending' ? { ...cell, status: 'canceled' } : cell
        ),
      })
    }
    void persistRun('canceled')
  }, [commitRun, persistRun])

  const retryCell = useCallback(
    async (cell: PlaygroundComparisonCell) => {
      const current = runRef.current
      if (!current || runningRef.current || retryingKey !== null) return
      const key = comparisonCellKey(cell)
      const latest = current.results.find(
        (candidate) => comparisonCellKey(candidate) === key
      )
      if (!latest || latest.status === 'succeeded') return
      stoppingRef.current = false
      stopCodeRef.current = ''
      const controller = new AbortController()
      controllerRef.current = controller
      setRetryingKey(key)
      try {
        await runOneCell(current.id, latest, undefined, controller.signal)
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null
        }
        setRetryingKey(null)
      }
      const after = runRef.current
      if (!after || after.id !== current.id) return
      const status: PlaygroundComparisonRunStatus = stopCodeRef.current
        ? 'failed'
        : 'completed'
      commitRun({ ...after, status })
      await persistChainRef.current
      await persistRun(status)
    },
    [commitRun, persistRun, retryingKey, runOneCell]
  )

  const setBaseline = useCallback(
    async (model: string) => {
      const current = runRef.current
      if (!current || runningRef.current) return
      const baselineModel = current.baselineModel === model ? '' : model
      commitRun({ ...current, baselineModel })
      await persistRun(current.status)
    },
    [commitRun, persistRun]
  )

  const load = useCallback(
    (next: PlaygroundComparisonRun) => {
      if (runningRef.current) return
      setMessage('')
      commitRun(next)
    },
    [commitRun]
  )

  const clear = useCallback(() => {
    if (runningRef.current) return
    setMessage('')
    commitRun(null)
  }, [commitRun])

  const remove = useCallback(
    async (runId: string): Promise<boolean> => {
      if (runningRef.current) return false
      try {
        await deletePlaygroundComparisonRun(runId)
      } catch (error: unknown) {
        if (isServerErrorCancelled(error)) return false
        setMessage(
          getServerErrorMessage(
            error,
            PLAYGROUND_COMPARISON_MESSAGES.DELETE_FAILED
          )
        )
        return false
      }
      if (runRef.current?.id === runId) commitRun(null)
      return true
    },
    [commitRun]
  )

  return {
    run,
    isRunning,
    retryingKey,
    message,
    start,
    stop,
    retryCell,
    setBaseline,
    load,
    clear,
    remove,
  }
}
