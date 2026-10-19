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
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasWorkflowCacheEntry,
  CanvasWorkflowRun,
  CanvasWorkflowRunNodeRecord,
} from '../types'
import {
  canvasWorkflowGroup,
  canvasWorkflowNodeText,
  canvasWorkflowPreferredSibling,
  isCanvasWorkflowStep,
  resolveCanvasWorkflowGeneration,
  resolveCanvasWorkflowImageSources,
  resolveCanvasWorkflowInput,
} from './canvas-workflow'

/**
 * PG2-07 node cache keys. A fingerprint folds in the step kind, model, group,
 * bounded generation parameters, resolved input, the IDs/outputs of every
 * upstream node and a structural workflow version. An unchanged upstream chain
 * therefore hits the cache on the next run, while a changed prompt, parameter,
 * reference image or topology produces a different key. The server treats the
 * fingerprint as an opaque string and only resolves it inside the owner's
 * finished runs.
 */
export const CANVAS_WORKFLOW_CACHE_VERSION = 'wf1'
export const CANVAS_WORKFLOW_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const CANVAS_WORKFLOW_CACHE_MAX_FINGERPRINTS = 128

/** Stable English sources for the reasons a rerun differs from its baseline. */
export const CANVAS_WORKFLOW_RUN_DIFF_REASONS = {
  ADDED: 'Only in the newer run',
  REMOVED: 'Only in the older run',
  STATUS: 'Status changed',
  COST: 'Cost changed',
  DURATION: 'Duration changed',
  CACHE: 'Cache use changed',
  OUTPUT: 'Output changed',
} as const

/**
 * FNV-1a over two independently seeded 32-bit lanes. A 64-bit hexadecimal
 * fingerprint is plenty for a board-local reuse key and avoids pulling a hash
 * dependency into the frontend.
 */
function canvasWorkflowHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0xcbf29ce4
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
    second ^= second >>> 13
  }
  return (
    (first >>> 0).toString(16).padStart(8, '0') +
    (second >>> 0).toString(16).padStart(8, '0')
  )
}

function joinFingerprintFields(fields: Array<string | number>): string {
  return fields.map((field) => String(field)).join('\u001f')
}

/**
 * A structural version of the board. It deliberately ignores node text and
 * model parameters: those are already part of a step's own fingerprint, so
 * editing the last prompt must not invalidate the three cached steps before it.
 */
export function canvasWorkflowGraphVersion(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): string {
  // Result and attachment nodes are outputs of a run, so counting them would
  // change the version as soon as the first run creates its result nodes and
  // would prevent the second run from ever reusing a step. Only runnable steps
  // define the executable topology; their inputs are fingerprinted separately.
  const stepIds = new Set(
    nodes
      .filter((node) => isCanvasWorkflowStep(node.data.kind))
      .map((node) => node.id)
  )
  const nodeKeys = nodes
    .filter((node) => stepIds.has(node.id))
    .map((node) => `${node.id}:${node.data.kind}`)
    .sort((left, right) => left.localeCompare(right))
  const edgeKeys = edges
    .filter((edge) => stepIds.has(edge.source) && stepIds.has(edge.target))
    .map(
      (edge) =>
        `${edge.source}>${edge.target}:${edge.sourceHandle ?? ''}:${edge.targetHandle ?? ''}`
    )
    .sort((left, right) => left.localeCompare(right))
  return `${CANVAS_WORKFLOW_CACHE_VERSION}:${canvasWorkflowHash(
    `${nodeKeys.join('|')}\u001e${edgeKeys.join('|')}`
  )}`
}

function workflowReferenceKey(
  node: CanvasFlowNode,
  outputs: Map<string, string>
): string {
  const reference = node.data.ref
  return [
    node.id,
    node.data.kind,
    canvasWorkflowHash(outputs.get(node.id)?.trim() ?? ''),
    canvasWorkflowHash(canvasWorkflowNodeText(node.data)),
    reference?.sessionId ?? '',
    reference?.attachmentId ?? '',
    reference?.artifactId ?? '',
    reference?.taskId ?? '',
    reference?.taskArtifactKey ?? '',
  ].join(':')
}

/**
 * The upstream identities a step consumes. The graph version catches topology,
 * while these keys catch an upstream output, attachment or artifact reference
 * that changed without changing the shape of the board.
 */
function canvasWorkflowUpstreamReferences(
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  outputs: Map<string, string>
): string[] {
  const byID = new Map(nodes.map((item) => [item.id, item]))
  const references = new Set<string>()
  for (const edge of edges) {
    if (edge.target !== node.id) continue
    const upstream = byID.get(edge.source)
    if (!upstream) continue
    const imageNode =
      canvasWorkflowPreferredSibling(upstream, nodes) ?? upstream
    references.add(workflowReferenceKey(upstream, outputs))
    references.add(workflowReferenceKey(imageNode, outputs))
  }
  for (const source of resolveCanvasWorkflowImageSources(node, nodes, edges)) {
    references.add(
      source.kind === 'attachment'
        ? `image:${source.nodeId}:${source.sessionId}:${source.attachmentId}`
        : `task:${source.nodeId}:${source.taskId}:${source.artifactKey ?? ''}`
    )
  }
  return [...references].sort((left, right) => left.localeCompare(right))
}

export type CanvasWorkflowStepFingerprintInput = {
  node: CanvasFlowNode
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  outputs: Map<string, string>
  workflowVersion: string
  input: string
  group: string
  /** The concrete seed this attempt sends; omitted for model steps. */
  seed?: number
}

/** Computes the reuse key of one step from its fully resolved attempt. */
export function canvasWorkflowStepFingerprint(
  input: CanvasWorkflowStepFingerprintInput
): string {
  const node = input.node
  if (!isCanvasWorkflowStep(node.data.kind)) return ''
  const model = node.data.workflow?.model?.trim() ?? ''
  if (!model) return ''
  const generation =
    node.data.kind === 'task' ? resolveCanvasWorkflowGeneration(node) : null
  const fields: Array<string | number> = [
    CANVAS_WORKFLOW_CACHE_VERSION,
    input.workflowVersion,
    node.data.kind,
    model,
    input.group.trim(),
    canvasWorkflowHash(input.input),
  ]
  if (generation) {
    fields.push(
      generation.generation,
      generation.size ?? '',
      generation.quality ?? '',
      generation.imageCount ?? 0,
      generation.duration ?? 0,
      input.seed ?? ''
    )
  }
  fields.push(
    ...canvasWorkflowUpstreamReferences(
      node,
      input.nodes,
      input.edges,
      input.outputs
    )
  )
  return `${CANVAS_WORKFLOW_CACHE_VERSION}:${canvasWorkflowHash(
    joinFingerprintFields(fields)
  )}`
}

/**
 * Fingerprints all steps of a planned run using the outputs currently stored on
 * the nodes. The runner prefetches this batch before the first step; at
 * execution time it recomputes the same key from the live outputs, so a step
 * whose upstream was re-executed with a different result misses safely.
 */
export function canvasWorkflowPlanFingerprints(
  steps: string[],
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  workflowVersion: string,
  group: string,
  outputs: Map<string, string> = new Map()
): string[] {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const fingerprints: string[] = []
  const seen = new Set<string>()
  for (const id of steps) {
    const node = byID.get(id)
    if (!node || !isCanvasWorkflowStep(node.data.kind)) continue
    const fingerprint = canvasWorkflowStepFingerprint({
      node,
      nodes,
      edges,
      outputs,
      workflowVersion,
      input: resolveCanvasWorkflowInput(node, nodes, edges, outputs),
      group: canvasWorkflowGroup(node, group),
      seed:
        node.data.kind === 'task'
          ? resolveCanvasWorkflowGeneration(node).seed
          : undefined,
    })
    if (!fingerprint || seen.has(fingerprint)) continue
    seen.add(fingerprint)
    fingerprints.push(fingerprint)
  }
  return fingerprints
}

export type CanvasWorkflowCacheSelectionOptions = {
  /** A forced rerun never adopts a cached step. */
  force?: boolean
  now?: number
  maxAgeMs?: number
}

/**
 * Indexes usable cache entries by fingerprint. A missing model output, a task
 * without a durable id, or an entry older than the artifact retention window
 * is excluded, so an expired output falls back to a fresh request.
 */
export function canvasWorkflowCacheIndex(
  entries: CanvasWorkflowCacheEntry[],
  options: CanvasWorkflowCacheSelectionOptions = {}
): Map<string, CanvasWorkflowCacheEntry> {
  const index = new Map<string, CanvasWorkflowCacheEntry>()
  if (options.force) return index
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? CANVAS_WORKFLOW_CACHE_MAX_AGE_MS
  for (const entry of entries) {
    const fingerprint = entry.fingerprint.trim()
    if (!fingerprint) continue
    if (
      entry.updatedAt > 0 &&
      now > entry.updatedAt &&
      now - entry.updatedAt > maxAge
    ) {
      continue
    }
    if (entry.kind === 'model' && !entry.output.trim()) continue
    if (entry.kind === 'task' && !entry.taskId.trim()) continue
    index.set(fingerprint, entry)
  }
  return index
}

/**
 * Turns one historical run into cache entries. "Restore this run" uses this to
 * adopt the run's successful steps on the next execution; a cached step keeps
 * its original fingerprint and output, never a token or URL.
 */
export function canvasWorkflowRunCacheEntries(
  run: CanvasWorkflowRun
): CanvasWorkflowCacheEntry[] {
  return run.nodes
    .filter(
      (node) =>
        node.status === 'succeeded' &&
        Boolean(node.fingerprint.trim()) &&
        (node.kind === 'model'
          ? Boolean(node.output.trim())
          : Boolean(node.taskId.trim()))
    )
    .map((node) => ({
      fingerprint: node.fingerprint,
      nodeId: node.nodeId,
      kind: node.kind,
      model: node.model,
      output: node.output,
      taskId: node.taskId,
      artifactKeys: node.artifactKeys,
      resultCount: node.resultCount,
      quota: node.quota,
      runId: run.id,
      updatedAt: run.updatedAt,
    }))
}

export type CanvasWorkflowRunDiffRow = {
  nodeId: string
  kind: 'model' | 'task'
  model: string
  before?: CanvasWorkflowRunNodeRecord
  after?: CanvasWorkflowRunNodeRecord
  changed: boolean
  reasons: string[]
}

function workflowNodeDiffReasons(
  before: CanvasWorkflowRunNodeRecord | undefined,
  after: CanvasWorkflowRunNodeRecord | undefined
): string[] {
  if (!before) return [CANVAS_WORKFLOW_RUN_DIFF_REASONS.ADDED]
  if (!after) return [CANVAS_WORKFLOW_RUN_DIFF_REASONS.REMOVED]
  const reasons: string[] = []
  if (before.status !== after.status) {
    reasons.push(CANVAS_WORKFLOW_RUN_DIFF_REASONS.STATUS)
  }
  if (before.quota !== after.quota) {
    reasons.push(CANVAS_WORKFLOW_RUN_DIFF_REASONS.COST)
  }
  if (before.durationMs !== after.durationMs) {
    reasons.push(CANVAS_WORKFLOW_RUN_DIFF_REASONS.DURATION)
  }
  if (before.cacheHit !== after.cacheHit) {
    reasons.push(CANVAS_WORKFLOW_RUN_DIFF_REASONS.CACHE)
  }
  if (before.output !== after.output) {
    reasons.push(CANVAS_WORKFLOW_RUN_DIFF_REASONS.OUTPUT)
  }
  return reasons
}

/**
 * Compares two runs step by step. The history panel uses it after a rerun; the
 * ordering follows the older run and appends steps only present in the newer
 * one, which keeps the waterfall stable.
 */
export function diffCanvasWorkflowRuns(
  before: CanvasWorkflowRun,
  after: CanvasWorkflowRun
): CanvasWorkflowRunDiffRow[] {
  const beforeNodes = new Map(before.nodes.map((node) => [node.nodeId, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.nodeId, node]))
  const ids = [
    ...before.nodes.map((node) => node.nodeId),
    ...after.nodes
      .map((node) => node.nodeId)
      .filter((id) => !beforeNodes.has(id)),
  ]
  return ids.map((id) => {
    const previous = beforeNodes.get(id)
    const current = afterNodes.get(id)
    const source = current ?? previous
    const reasons = workflowNodeDiffReasons(previous, current)
    return {
      nodeId: id,
      kind: source?.kind ?? 'model',
      model: source?.model ?? '',
      ...(previous ? { before: previous } : {}),
      ...(current ? { after: current } : {}),
      changed: reasons.length > 0,
      reasons,
    }
  })
}
