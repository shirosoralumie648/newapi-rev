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

import { sendChatCompletion } from '@/features/playground/api'
import { PLAYGROUND_TASK_TERMINAL_STATUSES } from '@/features/playground/constants'
import {
  cancelPlaygroundTask,
  submitImageGeneration,
  submitVideoGeneration,
} from '@/features/playground/generation-api'
import { getTaskArtifacts, getUserTaskLogs } from '@/features/usage-logs/api'
import type { TaskArtifact, TaskLog } from '@/features/usage-logs/types'
import {
  getServerErrorMessageKey,
  getServerErrorSources,
  isServerErrorCancelled,
} from '@/lib/server-error-message'

import {
  CANVAS_WORKFLOW_OUTPUT_MAX_CHARS,
  CANVAS_WORKFLOW_TASK_POLL_INTERVAL_MS,
} from '../constants'
import {
  boundCanvasWorkflowError,
  CANVAS_WORKFLOW_ERRORS,
  canvasWorkflowOutputTargets,
  orderCanvasWorkflow,
  resolveCanvasWorkflowInput,
  truncateCanvasWorkflowText,
  validateCanvasWorkflow,
} from '../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeWorkflowState,
} from '../types'
import type {
  CanvasNodeDataUpdate,
  CanvasNodeDataUpdateOptions,
} from './use-canvas-editor'

export type CanvasWorkflowRunPhase = 'idle' | 'running'

type CanvasWorkflowStepOutcome = 'succeeded' | 'failed' | 'canceled'

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

  const nodesRef = useRef(options.nodes)
  const edgesRef = useRef(options.edges)
  const groupRef = useRef(options.group)
  const updateRef = useRef(options.updateNodeData)
  const phaseRef = useRef(phase)
  nodesRef.current = options.nodes
  edgesRef.current = options.edges
  groupRef.current = options.group
  updateRef.current = options.updateNodeData
  phaseRef.current = phase

  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const outputsRef = useRef<Map<string, string>>(new Map())
  const pendingTaskRef = useRef<{ taskId: string; nodeId: string } | null>(null)
  const resumedRef = useRef(false)

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
    ): CanvasWorkflowStepOutcome => {
      if (generation !== runIdRef.current || isServerErrorCancelled(error)) {
        markStepCanceled(id)
        return 'canceled'
      }
      const text = workflowServerErrorText(error)
      markStepFailed(id, text)
      setMessage(text)
      return 'failed'
    },
    [markStepCanceled, markStepFailed]
  )

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
   * Settles a succeeded generation step: the durable task row is the status
   * source, and each artifact it exposes fills one downstream `task-result`
   * node with the task id plus the artifact key. Bytes stay behind the
   * owner-scoped artifact endpoints; only references are stored.
   */
  const applyTaskSuccess = useCallback(
    async (node: CanvasFlowNode, taskId: string): Promise<void> => {
      const targets = canvasWorkflowOutputTargets(
        node.id,
        nodesRef.current,
        edgesRef.current
      )
      let artifacts: TaskArtifact[] = []
      if (targets.length > 0) {
        try {
          const projection = await getTaskArtifacts(taskId)
          artifacts = projection.artifacts
        } catch {
          artifacts = []
        }
      }
      const model = node.data.workflow?.model?.trim() ?? ''
      for (const [index, targetId] of targets.entries()) {
        const artifact =
          artifacts.length > 0 ? artifacts[index % artifacts.length] : undefined
        const label = [model, artifact?.type].filter(Boolean).join(' · ')
        patchNode(targetId, () => ({
          ...(label ? { label } : {}),
          ref: {
            taskId,
            ...(artifact?.key ? { taskArtifactKey: artifact.key } : {}),
          },
        }))
      }
      markStepSucceeded(node.id, { taskId })
    },
    [markStepSucceeded, patchNode]
  )

  const runModelStep = useCallback(
    async (
      node: CanvasFlowNode,
      input: string,
      generation: number,
      signal: AbortSignal
    ): Promise<CanvasWorkflowStepOutcome> => {
      const model = node.data.workflow?.model?.trim() ?? ''
      try {
        const response = await sendChatCompletion(
          {
            model,
            group: groupRef.current,
            messages: [{ role: 'user', content: input }],
            stream: false,
          },
          signal
        )
        const output = (response.choices[0]?.message?.content ?? '').trim()
        if (!output) {
          markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.EMPTY_OUTPUT)
          setMessage(CANVAS_WORKFLOW_ERRORS.EMPTY_OUTPUT)
          return 'failed'
        }
        const bounded = truncateCanvasWorkflowText(
          output,
          CANVAS_WORKFLOW_OUTPUT_MAX_CHARS
        )
        outputsRef.current.set(node.id, bounded)
        markStepSucceeded(node.id, { inputText: input, output: bounded })
        return 'succeeded'
      } catch (error) {
        return stepErrorOutcome(node.id, error, generation)
      }
    },
    [markStepFailed, markStepSucceeded, stepErrorOutcome]
  )

  const runTaskStep = useCallback(
    async (
      node: CanvasFlowNode,
      input: string,
      adoptTaskId: string | null,
      generation: number,
      signal: AbortSignal
    ): Promise<CanvasWorkflowStepOutcome> => {
      const workflow = node.data.workflow
      const model = workflow?.model?.trim() ?? ''
      const group = groupRef.current
      try {
        if (workflow?.generation !== 'video') {
          const images = await submitImageGeneration(
            { model, prompt: input, group, size: workflow?.size },
            signal
          )
          const previews = images
            .map(
              (image) =>
                image.url ??
                (image.b64Json ? `data:image/png;base64,${image.b64Json}` : '')
            )
            .filter(Boolean)
          if (previews.length === 0) {
            markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.NO_IMAGE)
            setMessage(CANVAS_WORKFLOW_ERRORS.NO_IMAGE)
            return 'failed'
          }
          setResults((current) => ({ ...current, [node.id]: previews }))
          markStepSucceeded(node.id, {
            inputText: input,
            imageCount: previews.length,
          })
          return 'succeeded'
        }
        let taskId = adoptTaskId
        if (!taskId) {
          taskId = await submitVideoGeneration(
            {
              model,
              prompt: input,
              group,
              ...(workflow?.duration && workflow.duration > 0
                ? { duration: workflow.duration }
                : {}),
            },
            signal
          )
        }
        if (!taskId) {
          markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.NO_TASK_ID)
          setMessage(CANVAS_WORKFLOW_ERRORS.NO_TASK_ID)
          return 'failed'
        }
        patchNode(node.id, (data) => ({
          workflow: { ...data.workflow, taskId, inputText: input },
        }))
        pendingTaskRef.current = { taskId, nodeId: node.id }
        const row = await waitForTask(taskId, signal)
        pendingTaskRef.current = null
        if (generation !== runIdRef.current) {
          markStepCanceled(node.id)
          return 'canceled'
        }
        if (!row) {
          markStepFailed(node.id, CANVAS_WORKFLOW_ERRORS.RUN_FAILED)
          setMessage(CANVAS_WORKFLOW_ERRORS.RUN_FAILED)
          return 'failed'
        }
        if (row.status === 'FAILURE') {
          const reason =
            row.fail_reason?.trim() || CANVAS_WORKFLOW_ERRORS.RUN_FAILED
          markStepFailed(node.id, reason)
          setMessage(reason)
          return 'failed'
        }
        await applyTaskSuccess(node, taskId)
        return 'succeeded'
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
      stepErrorOutcome,
      waitForTask,
    ]
  )

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
      try {
        for (let index = startIndex; index < steps.length; index++) {
          if (generation !== runIdRef.current) break
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
          markStepRunning(id, {
            inputText: input,
            ...(node.data.workflow?.model
              ? { model: node.data.workflow.model }
              : {}),
          })
          if (!input) {
            markStepFailed(id, CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED)
            setMessage(CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED)
            return
          }
          // A task left running by an interrupted session is adopted instead of
          // submitted again, so one board never starts a duplicate task.
          const adoptTaskId =
            node.data.kind === 'task' &&
            node.data.workflow?.status === 'running' &&
            node.data.workflow.taskId
              ? node.data.workflow.taskId
              : null
          const outcome =
            node.data.kind === 'model'
              ? await runModelStep(node, input, generation, signal)
              : await runTaskStep(node, input, adoptTaskId, generation, signal)
          if (outcome !== 'succeeded') return
        }
      } finally {
        pendingTaskRef.current = null
        abortRef.current = null
        setActiveNodeId(null)
        setPhase('idle')
      }
    },
    [markStepFailed, markStepRunning, runModelStep, runTaskStep]
  )

  const start = useCallback(
    (fromNodeId?: string) => {
      if (phaseRef.current === 'running') return
      const runNodes = nodesRef.current
      const runEdges = edgesRef.current
      if (!groupRef.current.trim()) {
        setMessage(CANVAS_WORKFLOW_ERRORS.GROUP_REQUIRED)
        return
      }
      const validation = validateCanvasWorkflow(runNodes, runEdges)
      if (validation) {
        setMessage(validation)
        return
      }
      const order = orderCanvasWorkflow(runNodes, runEdges)
      if ('error' in order) {
        setMessage(order.error)
        return
      }
      let startIndex = 0
      if (fromNodeId) {
        const index = order.steps.indexOf(fromNodeId)
        if (index >= 0) startIndex = index
      }
      outputsRef.current = new Map()
      const generation = runIdRef.current + 1
      runIdRef.current = generation
      const controller = new AbortController()
      abortRef.current = controller
      setMessage(null)
      setPhase('running')
      void executeSteps(
        runNodes,
        runEdges,
        order.steps,
        startIndex,
        generation,
        controller.signal
      )
    },
    [executeSteps]
  )

  const retry = useCallback(
    (nodeId: string) => {
      start(nodeId)
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
        if (node) await applyTaskSuccess(node, pending.taskId)
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
        await applyTaskSuccess(node, taskId)
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
    run: start,
    retry,
    cancel,
    clearMessage,
  }
}
