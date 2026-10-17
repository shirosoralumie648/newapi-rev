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
import {
  CANVAS_WORKFLOW_ERROR_MAX_CHARS,
  CANVAS_WORKFLOW_INPUT_MAX_CHARS,
} from '../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasWorkflowNodeStatus,
} from '../types'

/**
 * Stable translation keys for workflow problems the UI shows directly. The
 * strings double as English source text and as i18n keys.
 */
export const CANVAS_WORKFLOW_ERRORS = {
  NO_STEPS: 'Add a model call or generation step to run the workflow.',
  CYCLE: 'Workflow connections must not form a cycle.',
  MODEL_REQUIRED: 'Choose a model for every workflow step.',
  INPUT_REQUIRED:
    'Connect a prompt or an upstream step before this workflow step.',
  GROUP_REQUIRED: 'The workflow needs an available user group.',
  EMPTY_OUTPUT: 'The model returned no text.',
  NO_TASK_ID: 'The generation task did not return a task id.',
  NO_IMAGE: 'The generation task returned no image.',
  RUN_FAILED: 'The workflow step failed.',
} as const

/** Translation keys for the run state a workflow node reports. */
export const CANVAS_WORKFLOW_STATUS_LABELS: Record<
  CanvasWorkflowNodeStatus,
  string
> = {
  idle: 'Not started',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}

/** A step is a node a workflow run actually executes. */
export function isCanvasWorkflowStep(kind: CanvasNodeKind): boolean {
  return kind === 'model' || kind === 'task'
}

/** The terminal node that receives a durable generation task reference. */
export function isCanvasWorkflowResult(kind: CanvasNodeKind): boolean {
  return kind === 'task-result'
}

export function truncateCanvasWorkflowText(
  value: string,
  limit: number
): string {
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * The text a producer node contributes to the chain: authored text, the saved
 * message snapshot or (for a step) the output of its last run. A node without
 * any of these contributes nothing; a missing source is not an error.
 */
export function canvasWorkflowNodeText(data: CanvasNodeData): string {
  return (
    data.text?.trim() ||
    data.snapshot?.text?.trim() ||
    data.workflow?.output?.trim() ||
    ''
  )
}

type CanvasWorkflowOrder =
  | { steps: string[]; error?: undefined }
  | { error: string }

/**
 * Steps of a canvas in dependency order. A cyclic graph has no order, so the
 * callers refuse to run it instead of executing an arbitrary prefix.
 */
export function orderCanvasWorkflow(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasWorkflowOrder {
  const known = new Set(nodes.map((node) => node.id))
  const remainingIncoming = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const node of nodes) {
    remainingIncoming.set(node.id, 0)
    outgoing.set(node.id, [])
  }
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue
    remainingIncoming.set(
      edge.target,
      (remainingIncoming.get(edge.target) ?? 0) + 1
    )
    outgoing.get(edge.source)?.push(edge.target)
  }
  const pending = nodes
    .filter((node) => (remainingIncoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
  const ordered: string[] = []
  while (pending.length > 0) {
    const id = pending.shift() as string
    ordered.push(id)
    for (const target of outgoing.get(id) ?? []) {
      const remaining = (remainingIncoming.get(target) ?? 0) - 1
      remainingIncoming.set(target, remaining)
      if (remaining === 0) pending.push(target)
    }
  }
  if (ordered.length !== nodes.length) {
    return { error: CANVAS_WORKFLOW_ERRORS.CYCLE }
  }
  const kindByID = new Map(nodes.map((node) => [node.id, node.data.kind]))
  return {
    steps: ordered.filter((id) =>
      isCanvasWorkflowStep(kindByID.get(id) ?? 'text')
    ),
  }
}

/**
 * Whether linking `source` to `target` would close a cycle. A canvas keeps the
 * general graph freedom of the editor, but a workflow run can only consume a
 * directed acyclic graph.
 */
export function wouldCreateCanvasWorkflowCycle(
  edges: CanvasFlowEdge[],
  source: string,
  target: string
): boolean {
  if (source === target) return true
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = outgoing.get(edge.source)
    if (targets) {
      targets.push(edge.target)
    } else {
      outgoing.set(edge.source, [edge.target])
    }
  }
  const seen = new Set<string>([target])
  const pending = [target]
  while (pending.length > 0) {
    const id = pending.pop() as string
    if (id === source) return true
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      pending.push(next)
    }
  }
  return false
}

/** Whether a step is wired to something, or carries its own instruction. */
export function hasCanvasWorkflowInput(
  node: CanvasFlowNode,
  edges: CanvasFlowEdge[]
): boolean {
  if (node.data.text?.trim()) return true
  return edges.some((edge) => edge.target === node.id)
}

/**
 * Checks a board before a run. A failure here is a configuration problem the
 * user can fix; runtime failures are reported per node instead.
 */
export function validateCanvasWorkflow(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): string | null {
  const order = orderCanvasWorkflow(nodes, edges)
  if (order.error) return order.error
  const steps = order.steps
  if (steps.length === 0) return CANVAS_WORKFLOW_ERRORS.NO_STEPS
  const byID = new Map(nodes.map((node) => [node.id, node]))
  for (const id of steps) {
    const node = byID.get(id)
    if (!node) continue
    if (!node.data.workflow?.model?.trim()) {
      return CANVAS_WORKFLOW_ERRORS.MODEL_REQUIRED
    }
    if (!hasCanvasWorkflowInput(node, edges)) {
      return CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED
    }
  }
  return null
}

/**
 * Resolves the text a step consumes: its own instruction first, then the text
 * of every directly connected upstream node in edge order. Step outputs of the
 * current run are passed in through `outputs`; a retry falls back to the output
 * the upstream step stored on its node, so a failed step can rerun without
 * recomputing the whole chain.
 */
export function resolveCanvasWorkflowInput(
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  outputs: Map<string, string>
): string {
  const byID = new Map(nodes.map((item) => [item.id, item]))
  const parts: string[] = []
  const own = node.data.text?.trim()
  if (own) parts.push(own)
  for (const edge of edges) {
    if (edge.target !== node.id) continue
    const upstream = byID.get(edge.source)
    if (!upstream) continue
    const text =
      outputs.get(upstream.id)?.trim() || canvasWorkflowNodeText(upstream.data)
    if (text) parts.push(text)
  }
  return truncateCanvasWorkflowText(
    parts.join('\n\n'),
    CANVAS_WORKFLOW_INPUT_MAX_CHARS
  )
}

/**
 * The `task-result` nodes directly downstream of a generation step, in edge
 * order. Each one receives one artifact reference of the settled task.
 */
export function canvasWorkflowOutputTargets(
  taskNodeId: string,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): string[] {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const targets: string[] = []
  const seen = new Set<string>()
  for (const edge of edges) {
    if (edge.source !== taskNodeId) continue
    const target = byID.get(edge.target)
    if (!target || !isCanvasWorkflowResult(target.data.kind)) continue
    if (seen.has(target.id)) continue
    seen.add(target.id)
    targets.push(target.id)
  }
  return targets
}

/** Bounds a failure message before it is stored on a node. */
export function boundCanvasWorkflowError(value: string): string {
  return truncateCanvasWorkflowText(value, CANVAS_WORKFLOW_ERROR_MAX_CHARS)
}
