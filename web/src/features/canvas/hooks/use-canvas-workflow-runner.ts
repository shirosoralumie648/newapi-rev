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
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getPlaygroundMessageCosts,
  sendChatCompletion,
} from '@/features/playground/api'
import { PLAYGROUND_TASK_TERMINAL_STATUSES } from '@/features/playground/constants'
import {
  cancelPlaygroundTask,
  submitImageGeneration,
  submitVideoGeneration,
} from '@/features/playground/generation-api'
import type {
  ChatCompletionUsage,
  ContentPart,
} from '@/features/playground/types'
import { getTaskArtifacts, getUserTaskLogs } from '@/features/usage-logs/api'
import type { TaskArtifact, TaskLog } from '@/features/usage-logs/types'
import {
  getServerErrorMessageKey,
  getServerErrorSources,
  isServerErrorCancelled,
} from '@/lib/server-error-message'

import {
  createCanvasWorkflowRunHistory,
  lookupCanvasWorkflowNodeCache,
  settleCanvasWorkflowRunBudget,
  updateCanvasWorkflowRunHistory,
} from '../api'
import {
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_WORKFLOW_GENERATION_LABELS,
  CANVAS_WORKFLOW_MESSAGES,
  CANVAS_WORKFLOW_OUTPUT_MAX_CHARS,
  CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
  CANVAS_WORKFLOW_TASK_POLL_INTERVAL_MS,
} from '../constants'
import {
  boundCanvasWorkflowError,
  CANVAS_WORKFLOW_ERRORS,
  canvasWorkflowGroup,
  canvasWorkflowOutputTargets,
  canvasWorkflowResultKind,
  canvasWorkflowRetryRecord,
  canvasWorkflowRetrySource,
  canvasWorkflowSelectionScope,
  isCanvasWorkflowResult,
  isCanvasWorkflowStep,
  orderCanvasWorkflow,
  randomCanvasWorkflowSeed,
  resolveCanvasWorkflowGeneration,
  resolveCanvasWorkflowImageSources,
  resolveCanvasWorkflowInput,
  truncateCanvasWorkflowText,
  validateCanvasWorkflow,
} from '../lib/canvas-workflow'
import { canvasWorkflowEstimateSteps } from '../lib/canvas-workflow-budget'
import type { CanvasWorkflowEstimateStepInput } from '../lib/canvas-workflow-budget'
import {
  CANVAS_WORKFLOW_CACHE_MAX_FINGERPRINTS,
  canvasWorkflowCacheIndex,
  canvasWorkflowGraphVersion,
  canvasWorkflowPlanFingerprints,
  canvasWorkflowRunCacheEntries,
  canvasWorkflowStepFingerprint,
} from '../lib/canvas-workflow-cache'
import {
  CanvasWorkflowImageError,
  readCanvasWorkflowImages,
} from '../lib/canvas-workflow-images'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasNodeWorkflowState,
  CanvasWorkflowCacheEntry,
  CanvasWorkflowRun,
  CanvasWorkflowRunNodeRecord,
  CanvasWorkflowRunStatus,
} from '../types'
import type {
  CanvasNodeDataUpdate,
  CanvasNodeDataUpdateOptions,
} from './use-canvas-editor'

export type CanvasWorkflowRunPhase = 'idle' | 'running'

type CanvasWorkflowStepOutcome = 'succeeded' | 'failed' | 'canceled'

/** The outcome plus the metadata a run-history node records for one step. */
type CanvasWorkflowStepResult = {
  outcome: CanvasWorkflowStepOutcome
  output?: string
  taskId?: string
  artifacts?: TaskArtifact[]
  resultCount?: number
  usage?: ChatCompletionUsage
  requestId?: string
  quota?: number
  error?: string
}

/** A planned run: the estimate request payload of the steps about to start. */
export interface CanvasWorkflowRunPlan {
  steps: CanvasWorkflowEstimateStepInput[]
  /** Whether the plan executes the whole board or the selected subgraph. */
  scope: 'workflow' | 'selection'
  /** History reruns set this so every step re-executes instead of adopting. */
  force?: boolean
}

/** Optional per-run behavior and display metadata. */
export interface CanvasWorkflowRunStartOptions {
  /** Bypass every node-cache entry for this run. */
  force?: boolean
  /** Server-estimated quota the run-budget dialog displayed. */
  estimateQuota?: number
  /** Optional BL-03 cap this run bills inside. */
  budgetCap?: number
}

/** A resolved plan: the graph and step order one execution walks. */
interface CanvasWorkflowPlannedRun {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  steps: string[]
  startIndex: number
}

/** The budget a run bills inside; every step request carries its run id. */
export interface CanvasWorkflowRunBudgetRef {
  runId: string
}

/** The resolved attempt values a step records and a result node repeats. */
type CanvasWorkflowAttempt = {
  inputText: string
  group: string
  inputImageCount: number
  /** Concrete seed sent by this attempt, including a random blank seed. */
  seed?: number
}

export interface CanvasWorkflowRunnerOptions {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  /** User group every relay call runs in; the server re-validates it. */
  group: string
  /** Node data writer of the canvas editor; run state skips undo history. */
  updateNodeData: (
    id: string,
    update: CanvasNodeDataUpdate,
    options?: CanvasNodeDataUpdateOptions
  ) => void
  /** Adds a node fed by an existing one; null when the canvas is full. */
  addLinkedNode: (
    kind: CanvasNodeKind,
    sourceId: string,
    data: Partial<CanvasNodeData>,
    position: { x: number; y: number }
  ) => string | null
  /** Owned canvas whose run history receives the run; absent disables history. */
  canvasId?: string
  /** Conversation the board was opened against, when any. */
  sessionId?: string
  /** Revision the run starts from, stored as display metadata. */
  workflowRevision?: number
}

/**
 * The untranslated English source of a server failure: the backend
 * `message_key` first, the stable code mapping second, then the raw `message`.
 * Storing the source instead of a rendered sentence keeps the node display
 * translatable after the interface language changes.
 */
function workflowServerErrorText(error: unknown): string {
  for (const source of getServerErrorSources(error)) {
    if (typeof source.message_key === 'string' && source.message_key.trim()) {
      return source.message_key
    }
  }
  const key = getServerErrorMessageKey(error)
  if (key) return key
  for (const source of getServerErrorSources(error)) {
    const message = source.message
    if (typeof message !== 'string' || !message.trim()) continue
    if (message === 'success') continue
    // A proxy's HTML error document is not an actionable API error message.
    if (/^\s*(?:<!doctype|<html[\s>])/i.test(message)) continue
    return message
  }
  return CANVAS_WORKFLOW_ERRORS.RUN_FAILED
}

/** Marks one attempt as started and clears the previous attempt's error. */
function beginWorkflowStep(
  data: CanvasNodeData,
  patch: CanvasNodeWorkflowState
): Partial<CanvasNodeData> {
  const next: CanvasNodeWorkflowState = {
    ...data.workflow,
    ...patch,
    status: 'running',
    attempts: (data.workflow?.attempts ?? 0) + 1,
    updatedAt: Date.now(),
  }
  delete next.error
  // A new attempt must not inherit the previous attempt's cached marker.
  delete next.cacheHit
  return { workflow: next }
}

function settleWorkflowStep(
  data: CanvasNodeData,
  patch: CanvasNodeWorkflowState
): Partial<CanvasNodeData> {
  const next: CanvasNodeWorkflowState = {
    ...data.workflow,
    ...patch,
    status: 'succeeded',
    updatedAt: Date.now(),
  }
  delete next.error
  return { workflow: next }
}

function failWorkflowStep(
  data: CanvasNodeData,
  error: string
): Partial<CanvasNodeData> {
  return {
    workflow: {
      ...data.workflow,
      status: 'failed',
      error: boundCanvasWorkflowError(error),
      updatedAt: Date.now(),
    },
  }
}

/** A settled step keeps its outcome; a cancel never rewrites success or failure. */
function cancelWorkflowStep(data: CanvasNodeData): Partial<CanvasNodeData> {
  const status = data.workflow?.status
  if (status === 'succeeded' || status === 'failed') return {}
  return {
    workflow: { ...data.workflow, status: 'canceled', updatedAt: Date.now() },
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError')
}

/**
 * The attempt values stored on a step node. A path that did not resolve them
 * itself (a late-settled or resumed task) repeats what the original attempt
 * recorded, so the result node's retry record stays complete.
 */
function storedWorkflowAttempt(
  node: CanvasFlowNode,
  fallbackGroup: string
): CanvasWorkflowAttempt {
  const workflow = node.data.workflow
  return {
    inputText: workflow?.inputText?.trim() ?? '',
    group: workflow?.group?.trim() || fallbackGroup,
    inputImageCount: workflow?.inputImageCount ?? 0,
    ...(workflow?.lastSeed
      ? { seed: workflow.lastSeed }
      : workflow?.seed
        ? { seed: workflow.seed }
        : {}),
  }
}

/** A waiting period that ends early when the run is canceled. */
function cancelableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    const handleAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

/**
 * Runs the workflow steps of one canvas: each `model` node calls the
 * Playground chat route, each `task` node submits through the Playground
 * generation routes and waits on its durable task row. The run is a plain
 * client-side interpretation of the graph; every request goes through the
 * existing /pg relay, so billing, quotas, permissions and channel selection
 * stay server-side. A failed step stops the run and can be retried on its own
 * while the upstream outputs stored on the nodes are reused.
 */
export function useCanvasWorkflowRunner(options: CanvasWorkflowRunnerOptions) {
  const [phase, setPhase] = useState<CanvasWorkflowRunPhase>('idle')
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Transient image previews of the current run, keyed by node id. */
  const [results, setResults] = useState<Record<string, string[]>>({})
  /** The persisted history row of the current or latest run. */
  const [historyRunId, setHistoryRunId] = useState<string | null>(null)
  /** Bumped after a run snapshot is finalized so the history panel reloads. */
  const [historyRevision, setHistoryRevision] = useState(0)

  const nodesRef = useRef(options.nodes)
  const edgesRef = useRef(options.edges)
  const groupRef = useRef(options.group)
  const updateRef = useRef(options.updateNodeData)
  const addLinkedNodeRef = useRef(options.addLinkedNode)
  const phaseRef = useRef(phase)
  nodesRef.current = options.nodes
  edgesRef.current = options.edges
  groupRef.current = options.group
  updateRef.current = options.updateNodeData
  addLinkedNodeRef.current = options.addLinkedNode
  phaseRef.current = phase

  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const outputsRef = useRef<Map<string, string>>(new Map())
  const pendingTaskRef = useRef<{ taskId: string; nodeId: string } | null>(null)
  const resumedRef = useRef(false)
  /** Run budget the current run bills inside; null bills the wallet directly. */
  const budgetRef = useRef<string | null>(null)
  const canvasIdRef = useRef(options.canvasId?.trim() ?? '')
  const sessionIdRef = useRef(options.sessionId?.trim() ?? '')
  const workflowRevisionRef = useRef(options.workflowRevision ?? 0)
  const forceCacheMissRef = useRef(false)
  /** Entries restored from a historical run; they outlive one execution. */
  const cacheBaselineRef = useRef<CanvasWorkflowCacheEntry[]>([])
  /** Entries prefetched for the current run, indexed by fingerprint. */
  const cacheEntriesRef = useRef<Map<string, CanvasWorkflowCacheEntry>>(
    new Map()
  )
  const workflowVersionRef = useRef('')
  const historyRunRef = useRef<{ id: string; revision: number } | null>(null)
  const historyStatusRef = useRef<CanvasWorkflowRunStatus>('running')
  const historyNodesRef = useRef<Map<string, CanvasWorkflowRunNodeRecord>>(
    new Map()
  )
  const historyRequestIdsRef = useRef<Map<string, string>>(new Map())
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve())
  canvasIdRef.current = options.canvasId?.trim() ?? ''
  sessionIdRef.current = options.sessionId?.trim() ?? ''
  workflowRevisionRef.current = options.workflowRevision ?? 0

  const patchNode = useCallback((id: string, update: CanvasNodeDataUpdate) => {
    updateRef.current(id, update, { record: false })
  }, [])

  const markStepRunning = useCallback(
    (id: string, patch: CanvasNodeWorkflowState) => {
      patchNode(id, (data) => beginWorkflowStep(data, patch))
    },
    [patchNode]
  )

  const markStepSucceeded = useCallback(
    (id: string, patch: CanvasNodeWorkflowState) => {
      patchNode(id, (data) => settleWorkflowStep(data, patch))
    },
    [patchNode]
  )

  const markStepFailed = useCallback(
    (id: string, error: string) => {
      patchNode(id, (data) => failWorkflowStep(data, error))
    },
    [patchNode]
  )

  const markStepCanceled = useCallback(
    (id: string) => {
      patchNode(id, (data) => cancelWorkflowStep(data))
    },
    [patchNode]
  )

  const stepErrorOutcome = useCallback(
    (
      id: string,
      error: unknown,
      generation: number
    ): CanvasWorkflowStepResult => {
      if (generation !== runIdRef.current || isServerErrorCancelled(error)) {
        markStepCanceled(id)
        return { outcome: 'canceled' }
      }
      // A local reference-image read failure is not a server answer; its
      // message is already a translation key.
      const text =
        error instanceof CanvasWorkflowImageError
          ? error.messageKey
          : workflowServerErrorText(error)
      markStepFailed(id, text)
      setMessage(text)
      return { outcome: 'failed', error: text }
    },
    [markStepCanceled, markStepFailed]
  )

  const emptyHistoryNode = useCallback(
    (node: CanvasFlowNode): CanvasWorkflowRunNodeRecord => ({
      nodeId: node.id,
      kind: node.data.kind === 'task' ? 'task' : 'model',
      model: node.data.workflow?.model?.trim() ?? '',
      group: canvasWorkflowGroup(node, groupRef.current),
      status: 'skipped',
      fingerprint: '',
      cacheHit: false,
      output: '',
      taskId: '',
      artifactKeys: [],
      resultCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      quota: 0,
      durationMs: 0,
      error: '',
      startedAt: 0,
      finishedAt: 0,
    }),
    []
  )

  /**
   * Serializes history writes so a later snapshot can never be overwritten by
   * an earlier one. History is best-effort: a failed snapshot must not fail or
   * cancel the workflow itself.
   */
  const queueHistoryUpdate = useCallback(
    (status?: CanvasWorkflowRunStatus): Promise<void> => {
      const run = historyRunRef.current
      if (!run) return Promise.resolve()
      // Capture the target run and its snapshot when the update is queued. A
      // later run replaces the refs before this request is sent, and an old
      // update must never write its nodes into the new run.
      const target = run
      const snapshot = [...historyNodesRef.current.values()]
      const nextStatus = status ?? historyStatusRef.current
      const queued = historyQueueRef.current.then(async () => {
        try {
          const updated = await updateCanvasWorkflowRunHistory(target.id, {
            revision: target.revision,
            status: nextStatus,
            nodes: snapshot,
          })
          target.revision = updated.revision
        } catch {
          // Keep the run id: a transient failure is retried by the next
          // snapshot, while a permanently rejected run simply stays partial.
        }
      })
      historyQueueRef.current = queued
      return queued
    },
    []
  )

  const recordHistoryStep = useCallback(
    (
      node: CanvasFlowNode,
      result: CanvasWorkflowStepResult,
      details: {
        fingerprint: string
        group: string
        startedAt: number
        finishedAt: number
        cacheHit: boolean
        artifacts?: TaskArtifact[]
      }
    ) => {
      const status =
        result.outcome === 'succeeded'
          ? 'succeeded'
          : result.outcome === 'failed'
            ? 'failed'
            : 'canceled'
      const artifacts = details.artifacts ?? result.artifacts ?? []
      const resultCount = result.resultCount ?? artifacts.length
      const usage = result.usage
      historyNodesRef.current.set(node.id, {
        nodeId: node.id,
        kind: node.data.kind === 'task' ? 'task' : 'model',
        model: node.data.workflow?.model?.trim() ?? '',
        group: details.group,
        status,
        fingerprint: details.fingerprint,
        cacheHit: details.cacheHit,
        output: result.output ?? '',
        taskId: result.taskId ?? '',
        artifactKeys: artifacts.map((artifact) => artifact.key),
        resultCount,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
        quota: result.quota ?? 0,
        durationMs:
          details.finishedAt > details.startedAt
            ? details.finishedAt - details.startedAt
            : 0,
        error: result.error ?? '',
        startedAt: details.startedAt,
        finishedAt: details.finishedAt,
      })
      if (result.requestId && status === 'succeeded') {
        historyRequestIdsRef.current.set(result.requestId, node.id)
      }
    },
    []
  )

  /**
   * Replaces the token figures recorded by the relay response with the settled
   * consume row, so a model step stores the same quota the account was billed.
   */
  const refreshHistoryCosts = useCallback(async (): Promise<void> => {
    const requestIds = [...historyRequestIdsRef.current.keys()]
    if (requestIds.length === 0) return
    try {
      const lookup = await getPlaygroundMessageCosts(requestIds)
      for (const requestId of requestIds) {
        const nodeId = historyRequestIdsRef.current.get(requestId)
        const node = nodeId ? historyNodesRef.current.get(nodeId) : undefined
        const cost = lookup.costs.get(requestId)
        if (!node || !cost) continue
        node.quota = cost.quota
        node.promptTokens = cost.promptTokens
        node.completionTokens = cost.completionTokens
        node.totalTokens = cost.totalTokens
      }
    } catch {
      // The relay response usage is still a useful fallback.
    }
  }, [])

  const beginRunHistory = useCallback(
    async (
      plan: CanvasWorkflowPlannedRun,
      options: CanvasWorkflowRunStartOptions,
      budget?: CanvasWorkflowRunBudgetRef,
      signal?: AbortSignal
    ): Promise<void> => {
      const canvasId = canvasIdRef.current
      historyRunRef.current = null
      setHistoryRunId(null)
      historyNodesRef.current = new Map()
      historyRequestIdsRef.current = new Map()
      historyStatusRef.current = 'running'
      forceCacheMissRef.current = options.force === true
      // The structural version belongs to the whole board, not the selected
      // subgraph, so a selection run can reuse the steps of a prior full run.
      const workflowVersion = canvasWorkflowGraphVersion(
        nodesRef.current,
        edgesRef.current
      )
      workflowVersionRef.current = workflowVersion
      cacheEntriesRef.current = new Map()
      if (!canvasId) return
      const fingerprints = canvasWorkflowPlanFingerprints(
        plan.steps.slice(plan.startIndex),
        plan.nodes,
        plan.edges,
        workflowVersion,
        groupRef.current
      ).slice(0, CANVAS_WORKFLOW_CACHE_MAX_FINGERPRINTS)
      if (!forceCacheMissRef.current && fingerprints.length > 0) {
        try {
          const remote = await lookupCanvasWorkflowNodeCache(
            canvasId,
            fingerprints,
            signal
          )
          // A restored baseline wins over the newest server row for the same
          // fingerprint: the user explicitly chose that run's output.
          cacheEntriesRef.current = canvasWorkflowCacheIndex([
            ...remote,
            ...cacheBaselineRef.current,
          ])
        } catch {
          cacheEntriesRef.current = canvasWorkflowCacheIndex(
            cacheBaselineRef.current
          )
        }
      }
      const byID = new Map(plan.nodes.map((node) => [node.id, node]))
      for (const id of plan.steps.slice(plan.startIndex)) {
        const node = byID.get(id)
        if (node) historyNodesRef.current.set(id, emptyHistoryNode(node))
      }
      try {
        const created = await createCanvasWorkflowRunHistory(
          {
            canvasId,
            ...(sessionIdRef.current
              ? { sessionId: sessionIdRef.current }
              : {}),
            workflowRevision: workflowRevisionRef.current,
            estimateQuota: options.estimateQuota ?? 0,
            budgetCap: budget?.runId ? (options.budgetCap ?? 0) : 0,
          },
          signal
        )
        historyRunRef.current = { id: created.id, revision: created.revision }
        setHistoryRunId(created.id)
      } catch (error) {
        // A full history or a stale client must not block the actual run.
        setMessage(workflowServerErrorText(error))
      }
    },
    [emptyHistoryNode]
  )

  const finalizeRunHistory = useCallback(
    async (status: CanvasWorkflowRunStatus): Promise<void> => {
      if (!historyRunRef.current) return
      historyStatusRef.current = status
      await refreshHistoryCosts()
      await queueHistoryUpdate(status)
      setHistoryRevision((current) => current + 1)
    },
    [queueHistoryUpdate, refreshHistoryCosts]
  )

  /** Adopts the successful steps of a historical run as this board's baseline. */
  const restoreCacheBaseline = useCallback((run: CanvasWorkflowRun) => {
    cacheBaselineRef.current = canvasWorkflowRunCacheEntries(run)
  }, [])

  const fetchTaskRow = useCallback(
    async (taskId: string): Promise<TaskLog | null> => {
      const response = await getUserTaskLogs({
        p: 1,
        page_size: 1,
        task_id: taskId,
      })
      const items = (response.data?.items ?? []) as TaskLog[]
      return items.find((item) => item.task_id === taskId) ?? items[0] ?? null
    },
    []
  )

  const waitForTask = useCallback(
    async (taskId: string, signal: AbortSignal): Promise<TaskLog | null> => {
      while (true) {
        const row = await fetchTaskRow(taskId)
        if (!row || PLAYGROUND_TASK_TERMINAL_STATUSES.includes(row.status)) {
          return row
        }
        await cancelableDelay(CANVAS_WORKFLOW_TASK_POLL_INTERVAL_MS, signal)
      }
    },
    [fetchTaskRow]
  )

  /**
   * Records a succeeded step on its downstream result nodes: existing nodes
   * are filled, and missing ones are added and linked, so a settled batch
   * always leaves one visible result node per artifact. New nodes stack
   * vertically, and exactly one result is marked preferred for downstream
   * steps. Nothing here stores a URL; the bytes stay behind the controlled
   * endpoints.
   */
  const recordStepResult = useCallback(
    (
      node: CanvasFlowNode,
      attempt: CanvasWorkflowAttempt,
      options: {
        suffix: string
        taskId?: string
        artifacts?: TaskArtifact[]
        resultCount?: number
      }
    ) => {
      const targets = canvasWorkflowOutputTargets(
        node.id,
        nodesRef.current,
        edgesRef.current
      )
      const record = canvasWorkflowRetryRecord(node, attempt)
      const model = node.data.workflow?.model?.trim() ?? ''
      const artifacts = options.artifacts ?? []
      const outputCount = Math.max(
        artifacts.length,
        options.resultCount ?? 0,
        1
      )
      const currentPreferredId =
        node.data.workflow?.preferredResultNodeId?.trim() ?? ''
      const currentPreferredIndex = targets.indexOf(currentPreferredId)
      let preferredId =
        currentPreferredIndex >= 0 && currentPreferredIndex < outputCount
          ? currentPreferredId
          : (targets[0] ?? '')
      const resultData = (
        artifact: TaskArtifact | undefined,
        index: number
      ): Partial<CanvasNodeData> => {
        const label = [model, artifact?.type ?? options.suffix]
          .filter(Boolean)
          .join(' · ')
        const indexedLabel = outputCount > 1 ? `${label} #${index + 1}` : label
        return {
          ...(indexedLabel ? { label: indexedLabel } : {}),
          ...(options.taskId
            ? {
                ref: {
                  taskId: options.taskId,
                  ...(artifact?.key ? { taskArtifactKey: artifact.key } : {}),
                },
              }
            : {}),
        }
      }
      for (let index = 0; index < outputCount; index++) {
        const artifact = artifacts[index]
        const targetId = targets[index]
        if (targetId) {
          patchNode(targetId, (data) => ({
            ...resultData(artifact, index),
            workflow: {
              ...data.workflow,
              ...record,
              preferred: targetId === preferredId,
            },
          }))
          continue
        }
        const isPreferred = preferredId === ''
        const created = addLinkedNodeRef.current(
          canvasWorkflowResultKind(artifact?.type),
          node.id,
          {
            ...resultData(artifact, index),
            workflow: { ...record, preferred: isPreferred },
          },
          {
            x: node.position.x + CANVAS_LINKED_NODE_OFFSET_X,
            y: node.position.y + index * CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
          }
        )
        if (!created) {
          setMessage(CANVAS_WORKFLOW_MESSAGES.RESULT_NODE_LIMIT)
          break
        }
        if (isPreferred) preferredId = created
      }
      if (preferredId && preferredId !== currentPreferredId) {
        patchNode(node.id, (data) => ({
          workflow: {
            ...data.workflow,
            preferredResultNodeId: preferredId,
          },
        }))
      }
    },
    [patchNode]
  )

  /**
   * Settles a succeeded generation task: the durable task row is the status
   * source, and the artifacts it exposes fill the step's result nodes, which
   * keep the task id plus the artifact key as the only reference.
   */
  const applyTaskSuccess = useCallback(
    async (
      node: CanvasFlowNode,
      taskId: string,
      attempt: CanvasWorkflowAttempt
    ): Promise<TaskArtifact[]> => {
      let artifacts: TaskArtifact[] = []
      try {
        const projection = await getTaskArtifacts(taskId)
        artifacts = projection.artifacts
      } catch {
        artifacts = []
      }
      const generation = resolveCanvasWorkflowGeneration(node).generation
      recordStepResult(node, attempt, {
        suffix: CANVAS_WORKFLOW_GENERATION_LABELS[generation],
        taskId,
        artifacts,
      })
      markStepSucceeded(node.id, { taskId, cacheHit: false })
      return artifacts
    },
    [markStepSucceeded, recordStepResult]
  )

  /**
   * Reuses one cached output without calling the relay. A model entry needs a
   * stored output; a task entry is adopted only while its durable task is still
   * successful and every referenced artifact is still available, so an expired
   * task or deleted artifact falls through to a fresh request.
   */
  const adoptCachedStep = useCallback(
    async (input: {
      node: CanvasFlowNode
      entry: CanvasWorkflowCacheEntry
      attempt: CanvasWorkflowAttempt
      inputText: string
      group: string
      fingerprint: string
      startedAt: number
    }): Promise<boolean> => {
      const { node, entry, attempt, inputText, group, fingerprint } = input
      if (entry.kind === 'model') {
        const output = entry.output.trim()
        if (!output) return false
        outputsRef.current.set(node.id, output)
        markStepSucceeded(node.id, {
          inputText,
          output,
          group,
          inputImageCount: attempt.inputImageCount,
          cacheHit: true,
        })
        recordHistoryStep(
          node,
          { outcome: 'succeeded', output, quota: 0 },
          {
            fingerprint,
            group,
            startedAt: input.startedAt,
            finishedAt: Date.now(),
            cacheHit: true,
          }
        )
        return true
      }
      const taskId = entry.taskId.trim()
      if (!taskId) return false
      let row: TaskLog | null = null
      try {
        row = await fetchTaskRow(taskId)
      } catch {
        return false
      }
      if (!row || row.status !== 'SUCCESS') return false
      let artifacts: TaskArtifact[] = []
      try {
        const projection = await getTaskArtifacts(taskId)
        artifacts = projection.artifacts
      } catch {
        return false
      }
      const availableKeys = new Set(artifacts.map((artifact) => artifact.key))
      if (
        entry.artifactKeys.some((key) => !availableKeys.has(key)) ||
        (entry.resultCount > 0 && artifacts.length === 0)
      ) {
        return false
      }
      const resultCount = entry.resultCount || artifacts.length
      const generation = resolveCanvasWorkflowGeneration(node).generation
      recordStepResult(node, attempt, {
        suffix: CANVAS_WORKFLOW_GENERATION_LABELS[generation],
        taskId,
        artifacts,
        resultCount,
      })
      markStepSucceeded(node.id, {
        taskId,
        inputText,
        group,
        inputImageCount: attempt.inputImageCount,
        ...(generation === 'image' ? { resultImageCount: resultCount } : {}),
        cacheHit: true,
      })
      recordHistoryStep(
        node,
        {
          outcome: 'succeeded',
          taskId,
          artifacts,
          resultCount,
          quota: 0,
        },
        {
          fingerprint,
          group,
          startedAt: input.startedAt,
          finishedAt: Date.now(),
          cacheHit: true,
        }
      )
      return true
    },
    [fetchTaskRow, markStepSucceeded, recordHistoryStep, recordStepResult]
  )

  /**
   * Reads the reference images a step consumes from its connected nodes. The
   * read path enforces the count limit and fails the step instead of silently
   * dropping the user's input.
   */
  const readStepImages = useCallback(
    async (
      node: CanvasFlowNode,
      nodes: CanvasFlowNode[],
      edges: CanvasFlowEdge[],
      signal: AbortSignal
    ): Promise<string[]> => {
      const sources = resolveCanvasWorkflowImageSources(node, nodes, edges)
      if (sources.length === 0) return []
      return readCanvasWorkflowImages(sources, signal)
    },
    []
  )

  const runModelStep = useCallback(
    async (
      node: CanvasFlowNode,
      input: string,
      group: string,
      nodes: CanvasFlowNode[],
      edges: CanvasFlowEdge[],
      generation: number,
      signal: AbortSignal
    ): Promise<CanvasWorkflowStepResult> => {
      const model = node.data.workflow?.model?.trim() ?? ''
      try {
        const images = await readStepImages(node, nodes, edges, signal)
        const content: string | ContentPart[] =
          images.length === 0
            ? input
            : [
                { type: 'text', text: input },
                ...images.map((url) => ({
                  type: 'image_url' as const,
                  image_url: { url },
                })),
              ]
        const { response, requestId } = await sendChatCompletion(
          {
            model,
            group,
            messages: [{ role: 'user', content }],
            stream: false,
          },
          signal,
          budgetRef.current ?? undefined
        )
        const output = (response.choices[0]?.message?.content ?? '').trim()
        if (!output) {
          markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.EMPTY_OUTPUT)
          setMessage(CANVAS_WORKFLOW_ERRORS.EMPTY_OUTPUT)
          return {
            outcome: 'failed',
            error: CANVAS_WORKFLOW_ERRORS.EMPTY_OUTPUT,
          }
        }
        const bounded = truncateCanvasWorkflowText(
          output,
          CANVAS_WORKFLOW_OUTPUT_MAX_CHARS
        )
        outputsRef.current.set(node.id, bounded)
        markStepSucceeded(node.id, {
          inputText: input,
          output: bounded,
          group,
          inputImageCount: images.length,
          cacheHit: false,
        })
        return {
          outcome: 'succeeded',
          output: bounded,
          usage: response.usage,
          requestId,
        }
      } catch (error) {
        return stepErrorOutcome(node.id, error, generation)
      }
    },
    [markStepFailed, markStepSucceeded, readStepImages, stepErrorOutcome]
  )

  const runTaskStep = useCallback(
    async (
      node: CanvasFlowNode,
      input: string,
      group: string,
      nodes: CanvasFlowNode[],
      edges: CanvasFlowEdge[],
      adoptTaskId: string | null,
      seed: number | undefined,
      generation: number,
      signal: AbortSignal
    ): Promise<CanvasWorkflowStepResult> => {
      const config = resolveCanvasWorkflowGeneration(node)
      const model = node.data.workflow?.model?.trim() ?? ''
      try {
        const images = await readStepImages(node, nodes, edges, signal)
        let taskId = adoptTaskId
        if (!taskId && config.generation !== 'video') {
          const outcome = await submitImageGeneration(
            {
              model,
              prompt: input,
              group,
              size: config.size,
              quality: config.quality,
              count: config.imageCount,
              seed,
              images,
            },
            signal,
            budgetRef.current ?? undefined
          )
          if (outcome.kind === 'images') {
            const previews = outcome.images
              .map(
                (image) =>
                  image.url ??
                  (image.b64Json
                    ? `data:image/png;base64,${image.b64Json}`
                    : '')
              )
              .filter(Boolean)
            if (previews.length === 0) {
              markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.NO_IMAGE)
              setMessage(CANVAS_WORKFLOW_ERRORS.NO_IMAGE)
              return {
                outcome: 'failed',
                error: CANVAS_WORKFLOW_ERRORS.NO_IMAGE,
              }
            }
            setResults((current) => ({ ...current, [node.id]: previews }))
            recordStepResult(
              node,
              { inputText: input, group, inputImageCount: images.length, seed },
              {
                suffix: CANVAS_WORKFLOW_GENERATION_LABELS.image,
                resultCount: previews.length,
              }
            )
            markStepSucceeded(node.id, {
              inputText: input,
              group,
              inputImageCount: images.length,
              resultImageCount: previews.length,
              cacheHit: false,
            })
            return { outcome: 'succeeded', resultCount: previews.length }
          }
          // A model served by a task plugin answers with a durable task
          // instead of images; the row and its stored artifacts then settle
          // the step exactly like a video step.
          taskId = outcome.taskId
        }
        if (!taskId && config.generation === 'video') {
          taskId = await submitVideoGeneration(
            {
              model,
              prompt: input,
              group,
              duration: config.duration,
              size: config.size,
              seed,
              images,
            },
            signal,
            budgetRef.current ?? undefined
          )
        }
        if (!taskId) {
          markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.NO_TASK_ID)
          setMessage(CANVAS_WORKFLOW_ERRORS.NO_TASK_ID)
          return {
            outcome: 'failed',
            error: CANVAS_WORKFLOW_ERRORS.NO_TASK_ID,
          }
        }
        patchNode(node.id, (data) => ({
          workflow: {
            ...data.workflow,
            taskId,
            inputText: input,
            group,
            inputImageCount: images.length,
          },
        }))
        pendingTaskRef.current = { taskId, nodeId: node.id }
        const row = await waitForTask(taskId, signal)
        pendingTaskRef.current = null
        if (generation !== runIdRef.current) {
          markStepCanceled(node.id)
          return { outcome: 'canceled', taskId }
        }
        if (!row) {
          markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.RUN_FAILED)
          setMessage(CANVAS_WORKFLOW_ERRORS.RUN_FAILED)
          return {
            outcome: 'failed',
            error: CANVAS_WORKFLOW_ERRORS.RUN_FAILED,
            taskId,
          }
        }
        if (row.status === 'FAILURE') {
          const reason =
            row.fail_reason?.trim() || CANVAS_WORKFLOW_ERRORS.RUN_FAILED
          markStepFailed(node.id, reason)
          setMessage(reason)
          return { outcome: 'failed', error: reason, taskId }
        }
        const artifacts = await applyTaskSuccess(node, taskId, {
          inputText: input,
          group,
          inputImageCount: images.length,
          seed,
        })
        return {
          outcome: 'succeeded',
          taskId,
          artifacts,
          resultCount: artifacts.length,
          quota: row.quota,
        }
      } catch (error) {
        pendingTaskRef.current = null
        return stepErrorOutcome(node.id, error, generation)
      }
    },
    [
      applyTaskSuccess,
      markStepCanceled,
      markStepFailed,
      markStepSucceeded,
      patchNode,
      readStepImages,
      recordStepResult,
      stepErrorOutcome,
      waitForTask,
    ]
  )

  /**
   * Settles the budget of a stopped run: the server bills the step allocations
   * the run recorded and returns the unspent cap to the wallet. The call is
   * idempotent, so a retried settlement reports the recorded outcome, and a
   * failure is shown because an unsettled budget only returns its cap when the
   * reservation expires.
   */
  const settleRunBudget = useCallback((runId: string) => {
    settleCanvasWorkflowRunBudget(runId).catch((error: unknown) => {
      setMessage(workflowServerErrorText(error))
    })
  }, [])

  const executeSteps = useCallback(
    async (
      runNodes: CanvasFlowNode[],
      runEdges: CanvasFlowEdge[],
      steps: string[],
      startIndex: number,
      generation: number,
      signal: AbortSignal
    ): Promise<void> => {
      const byID = new Map(runNodes.map((node) => [node.id, node]))
      let finalStatus: CanvasWorkflowRunStatus = 'completed'
      try {
        for (let index = startIndex; index < steps.length; index++) {
          if (generation !== runIdRef.current) {
            finalStatus = 'canceled'
            break
          }
          const id = steps[index]
          const node = byID.get(id)
          if (!node) continue
          setActiveNodeId(id)
          const input = resolveCanvasWorkflowInput(
            node,
            runNodes,
            runEdges,
            outputsRef.current
          )
          // The step's own group override wins over the canvas group; the
          // server re-validates it against the account's usable groups.
          const group = canvasWorkflowGroup(node, groupRef.current)
          // A task left running by an interrupted session is adopted instead of
          // submitted again, so one board never starts a duplicate task.
          const adoptTaskId =
            node.data.kind === 'task' &&
            node.data.workflow?.status === 'running' &&
            node.data.workflow.taskId
              ? node.data.workflow.taskId
              : null
          const explicitSeed =
            node.data.kind === 'task'
              ? resolveCanvasWorkflowGeneration(node).seed
              : undefined
          const attemptSeed =
            node.data.kind === 'task'
              ? adoptTaskId
                ? (node.data.workflow?.lastSeed ?? explicitSeed)
                : (explicitSeed ?? randomCanvasWorkflowSeed())
              : undefined
          const startedAt = Date.now()
          const attempt: CanvasWorkflowAttempt = {
            inputText: input,
            group,
            inputImageCount: resolveCanvasWorkflowImageSources(
              node,
              runNodes,
              runEdges
            ).length,
            ...(attemptSeed === undefined ? {} : { seed: attemptSeed }),
          }
          markStepRunning(id, {
            inputText: input,
            group,
            ...(node.data.workflow?.model
              ? { model: node.data.workflow.model }
              : {}),
            ...(attemptSeed === undefined ? {} : { lastSeed: attemptSeed }),
          })
          if (!input) {
            markStepFailed(id, CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED)
            recordHistoryStep(
              node,
              {
                outcome: 'failed',
                error: CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED,
              },
              {
                fingerprint: '',
                group,
                startedAt,
                finishedAt: Date.now(),
                cacheHit: false,
              }
            )
            setMessage(CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED)
            finalStatus = 'failed'
            return
          }
          const fingerprint = canvasWorkflowStepFingerprint({
            node,
            nodes: runNodes,
            edges: runEdges,
            outputs: outputsRef.current,
            workflowVersion: workflowVersionRef.current,
            input,
            group,
            seed: attemptSeed,
          })
          // An interrupted durable task is settled for real, not replaced by
          // an older cached output for the same prompt.
          const cached =
            !forceCacheMissRef.current && !adoptTaskId && fingerprint
              ? cacheEntriesRef.current.get(fingerprint)
              : undefined
          if (cached) {
            const adopted = await adoptCachedStep({
              node,
              entry: cached,
              attempt,
              inputText: input,
              group,
              fingerprint,
              startedAt,
            })
            if (generation !== runIdRef.current) {
              finalStatus = 'canceled'
              break
            }
            if (adopted) {
              void queueHistoryUpdate()
              continue
            }
            // A stale task row, a missing artifact or an empty output turns
            // this step into a normal request, never into a failed step.
            cacheEntriesRef.current.delete(fingerprint)
          }
          const result =
            node.data.kind === 'model'
              ? await runModelStep(
                  node,
                  input,
                  group,
                  runNodes,
                  runEdges,
                  generation,
                  signal
                )
              : await runTaskStep(
                  node,
                  input,
                  group,
                  runNodes,
                  runEdges,
                  adoptTaskId,
                  attemptSeed,
                  generation,
                  signal
                )
          recordHistoryStep(node, result, {
            fingerprint,
            group,
            startedAt,
            finishedAt: Date.now(),
            cacheHit: false,
          })
          if (result.outcome !== 'succeeded') {
            finalStatus = result.outcome === 'canceled' ? 'canceled' : 'failed'
            return
          }
          void queueHistoryUpdate()
        }
      } catch (error) {
        finalStatus = 'failed'
        setMessage(workflowServerErrorText(error))
      } finally {
        pendingTaskRef.current = null
        abortRef.current = null
        // The run has stopped (finished, failed or left the canvas): its budget
        // settles on the step allocations recorded so far.
        const budgetRunId = budgetRef.current
        budgetRef.current = null
        if (budgetRunId) settleRunBudget(budgetRunId)
        if (generation !== runIdRef.current && finalStatus === 'completed') {
          finalStatus = 'canceled'
        }
        await finalizeRunHistory(finalStatus)
        setActiveNodeId(null)
        setPhase('idle')
      }
    },
    [
      adoptCachedStep,
      finalizeRunHistory,
      markStepFailed,
      markStepRunning,
      queueHistoryUpdate,
      recordHistoryStep,
      runModelStep,
      runTaskStep,
      settleRunBudget,
    ]
  )

  /**
   * Validates the board exactly like a run and resolves the steps to execute.
   * A null answer means the run was refused and `message` says why.
   */
  const planRun = useCallback(
    (fromNodeId?: string): CanvasWorkflowPlannedRun | null => {
      const nodes = nodesRef.current
      const edges = edgesRef.current
      if (!groupRef.current.trim()) {
        setMessage(CANVAS_WORKFLOW_ERRORS.GROUP_REQUIRED)
        return null
      }
      const validation = validateCanvasWorkflow(nodes, edges)
      if (validation) {
        setMessage(validation)
        return null
      }
      const order = orderCanvasWorkflow(nodes, edges)
      if ('error' in order) {
        setMessage(order.error)
        return null
      }
      let startIndex = 0
      if (fromNodeId) {
        const index = order.steps.indexOf(fromNodeId)
        if (index >= 0) startIndex = index
      }
      return { nodes, edges, steps: order.steps, startIndex }
    },
    []
  )

  /**
   * Plans a run of the selected subgraph only. The scope keeps every selected
   * node, the descendants of a selected group box and all upstream ancestors,
   * so a chosen step still resolves its inputs; validation and pricing run
   * against that same scope. A selection without any runnable step is refused
   * with its own message instead of the whole-board one.
   */
  const planSelection = useCallback((): CanvasWorkflowPlannedRun | null => {
    const nodes = nodesRef.current
    const edges = edgesRef.current
    if (!groupRef.current.trim()) {
      setMessage(CANVAS_WORKFLOW_ERRORS.GROUP_REQUIRED)
      return null
    }
    const selected = nodes.filter((node) => node.selected === true)
    if (selected.length === 0) {
      setMessage(CANVAS_WORKFLOW_MESSAGES.SELECTION_EMPTY)
      return null
    }
    const scope = canvasWorkflowSelectionScope(
      nodes,
      edges,
      selected.map((node) => node.id)
    )
    const validation = validateCanvasWorkflow(scope.nodes, scope.edges)
    if (validation) {
      setMessage(
        validation === CANVAS_WORKFLOW_ERRORS.NO_STEPS
          ? CANVAS_WORKFLOW_MESSAGES.SELECTION_NO_STEPS
          : validation
      )
      return null
    }
    const order = orderCanvasWorkflow(scope.nodes, scope.edges)
    if ('error' in order) {
      setMessage(order.error)
      return null
    }
    return {
      nodes: scope.nodes,
      edges: scope.edges,
      steps: order.steps,
      startIndex: 0,
    }
  }, [])

  /** Starts one resolved plan, charging it inside `budget` when given. */
  const startPlannedRun = useCallback(
    (
      plan: CanvasWorkflowPlannedRun,
      budget?: CanvasWorkflowRunBudgetRef,
      runOptions: CanvasWorkflowRunStartOptions = {}
    ) => {
      if (phaseRef.current === 'running') return
      outputsRef.current = new Map()
      budgetRef.current = budget?.runId ?? null
      const generation = runIdRef.current + 1
      runIdRef.current = generation
      const controller = new AbortController()
      abortRef.current = controller
      setMessage(null)
      setPhase('running')
      void (async () => {
        await beginRunHistory(plan, runOptions, budget, controller.signal)
        await executeSteps(
          plan.nodes,
          plan.edges,
          plan.steps,
          plan.startIndex,
          generation,
          controller.signal
        )
      })().catch((error: unknown) => {
        if (generation === runIdRef.current) {
          setMessage(workflowServerErrorText(error))
          setPhase('idle')
          abortRef.current = null
        }
      })
    },
    [beginRunHistory, executeSteps]
  )

  /**
   * The price-estimate payload of the run a click would start. The board is
   * validated first, so the estimate is only offered when the same click would
   * actually run; the workspace asks the server to price it and shows the
   * total before anything is sent.
   */
  const estimateRun = useCallback(
    (fromNodeId?: string): CanvasWorkflowRunPlan | null => {
      const plan = planRun(fromNodeId)
      if (!plan) return null
      setMessage(null)
      return {
        scope: 'workflow',
        steps: canvasWorkflowEstimateSteps(
          plan.steps.slice(plan.startIndex),
          plan.nodes,
          plan.edges,
          groupRef.current
        ),
      }
    },
    [planRun]
  )

  /**
   * The priced estimate of the selected subgraph. Reuses the same budget
   * dialog as a full run; only the executed scope differs.
   */
  const estimateSelection = useCallback((): CanvasWorkflowRunPlan | null => {
    const plan = planSelection()
    if (!plan) return null
    setMessage(null)
    return {
      scope: 'selection',
      steps: canvasWorkflowEstimateSteps(
        plan.steps,
        plan.nodes,
        plan.edges,
        groupRef.current
      ),
    }
  }, [planSelection])

  const start = useCallback(
    (
      fromNodeId?: string,
      budget?: CanvasWorkflowRunBudgetRef,
      runOptions?: CanvasWorkflowRunStartOptions
    ) => {
      if (phaseRef.current === 'running') return
      const plan = planRun(fromNodeId)
      if (!plan) return
      startPlannedRun(plan, budget, runOptions)
    },
    [planRun, startPlannedRun]
  )

  /** Runs the planned selection scope, billed inside `budget` when given. */
  const startSelection = useCallback(
    (
      budget?: CanvasWorkflowRunBudgetRef,
      runOptions?: CanvasWorkflowRunStartOptions
    ) => {
      if (phaseRef.current === 'running') return
      const plan = planSelection()
      if (!plan) return
      startPlannedRun(plan, budget, runOptions)
    },
    [planSelection, startPlannedRun]
  )

  /**
   * Retries one step. A result node points at the step that produced it, so
   * one click on a result re-issues the same request; a result whose step is
   * gone reports why instead of running an unrelated prefix of the board.
   */
  const retry = useCallback(
    (nodeId: string) => {
      const target = nodesRef.current.find((node) => node.id === nodeId)
      if (!target) {
        setMessage(CANVAS_WORKFLOW_MESSAGES.RETRY_SOURCE_MISSING)
        return
      }
      if (!isCanvasWorkflowResult(target.data.kind)) {
        start(nodeId)
        return
      }
      const sourceId = canvasWorkflowRetrySource(target)
      const source = sourceId
        ? nodesRef.current.find((node) => node.id === sourceId)
        : undefined
      if (!source || !isCanvasWorkflowStep(source.data.kind)) {
        setMessage(CANVAS_WORKFLOW_MESSAGES.RETRY_SOURCE_MISSING)
        return
      }
      start(source.id)
    },
    [start]
  )

  /**
   * Stops the local run and cancels the durable task it is waiting on. A task
   * that finished meanwhile answers with the stable not-cancelable error; the
   * durable row then decides the node's final state.
   */
  const cancel = useCallback(async (): Promise<void> => {
    if (phaseRef.current !== 'running') return
    runIdRef.current += 1
    const pending = pendingTaskRef.current
    abortRef.current?.abort()
    abortRef.current = null
    if (!pending) return
    try {
      await cancelPlaygroundTask(pending.taskId)
      markStepCanceled(pending.nodeId)
    } catch (error) {
      const row = await fetchTaskRow(pending.taskId).catch(() => null)
      if (row?.status === 'FAILURE') {
        markStepFailed(
          pending.nodeId,
          row.fail_reason?.trim() || CANVAS_WORKFLOW_ERRORS.RUN_FAILED
        )
        return
      }
      if (row?.status === 'SUCCESS') {
        const node = nodesRef.current.find((item) => item.id === pending.nodeId)
        if (node) {
          await applyTaskSuccess(
            node,
            pending.taskId,
            storedWorkflowAttempt(node, groupRef.current)
          )
        }
        return
      }
      markStepCanceled(pending.nodeId)
      setMessage(workflowServerErrorText(error))
    }
  }, [applyTaskSuccess, fetchTaskRow, markStepCanceled, markStepFailed])

  const clearMessage = useCallback(() => setMessage(null), [])

  /**
   * Settles a task the user left running in an earlier session (or before a
   * reload) from its durable row. A transient read failure leaves the node
   * running so a later load settles it again.
   */
  const settleResumedTask = useCallback(
    async (node: CanvasFlowNode): Promise<void> => {
      const taskId = node.data.workflow?.taskId
      if (!taskId) return
      try {
        const row = await fetchTaskRow(taskId)
        if (!row || !PLAYGROUND_TASK_TERMINAL_STATUSES.includes(row.status)) {
          return
        }
        if (row.status === 'FAILURE') {
          markStepFailed(
            node.id,
            row.fail_reason?.trim() || CANVAS_WORKFLOW_ERRORS.RUN_FAILED
          )
          return
        }
        await applyTaskSuccess(
          node,
          taskId,
          storedWorkflowAttempt(node, groupRef.current)
        )
      } catch {
        // Keep the running state; the next load settles from the durable row.
      }
    },
    [applyTaskSuccess, fetchTaskRow, markStepFailed]
  )

  useEffect(() => {
    if (resumedRef.current) return
    resumedRef.current = true
    const pending = nodesRef.current.filter(
      (node) =>
        node.data.kind === 'task' &&
        node.data.workflow?.status === 'running' &&
        Boolean(node.data.workflow.taskId)
    )
    for (const node of pending) {
      void settleResumedTask(node)
    }
  }, [settleResumedTask])

  useEffect(() => {
    return () => {
      // Leaving the canvas stops the local run only; the durable task keeps
      // running upstream and is settled on the next load.
      runIdRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  return {
    phase,
    activeNodeId,
    message,
    results,
    /** The persisted row of the current or latest run, when history is on. */
    historyRunId,
    /** Changes when a run snapshot is finalized; reload the history list. */
    historyRevision,
    /** The priced step payload of a run a click would start. */
    estimate: estimateRun,
    run: start,
    /** The priced step payload of the selected subgraph run. */
    estimateSelection,
    runSelection: startSelection,
    retry,
    cancel,
    clearMessage,
    /** Makes a historical run's successful steps the next cache baseline. */
    restoreCacheBaseline,
  }
}
