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
import { playgroundAttachmentKind } from '@/features/playground/constants'

import {
  CANVAS_NODE_KIND_LABELS,
  CANVAS_WORKFLOW_DURATION_MAX_SECONDS,
  CANVAS_WORKFLOW_ERROR_MAX_CHARS,
  CANVAS_WORKFLOW_IMAGE_COUNTS,
  CANVAS_WORKFLOW_IMAGE_QUALITIES,
  CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS,
  CANVAS_WORKFLOW_INPUT_MAX_CHARS,
  CANVAS_WORKFLOW_MENTION_MAX_MATCHES,
  CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS,
} from '../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasNodeWorkflowState,
  CanvasWorkflowGenerationKind,
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

/** The terminal nodes that receive a durable generation task reference. */
export function isCanvasWorkflowResult(kind: CanvasNodeKind): boolean {
  return kind === 'task-result' || kind === 'video' || kind === 'audio'
}

/**
 * The result node kind one settled artifact fills: an image or an unknown
 * type previews in a `task-result`, while video and audio get a node that
 * plays the artifact through the controlled task artifact endpoint.
 */
export function canvasWorkflowResultKind(
  artifactType?: string
): CanvasNodeKind {
  if (artifactType === 'video') return 'video'
  if (artifactType === 'audio') return 'audio'
  return 'task-result'
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

/** The label a mention and the node header use: the authored label first. */
export function canvasWorkflowNodeLabel(data: CanvasNodeData): string {
  return data.label?.trim() || CANVAS_NODE_KIND_LABELS[data.kind]
}

/** Whether a node carries text a mention can substitute. */
export function canvasWorkflowNodeHasText(data: CanvasNodeData): boolean {
  return canvasWorkflowNodeText(data) !== ''
}

/** Whether a node carries image bytes a step can read as reference input. */
export function canvasWorkflowNodeHasImage(data: CanvasNodeData): boolean {
  if (data.sourceDeleted === true) return false
  if (data.kind === 'image') {
    return Boolean(data.ref?.sessionId && data.ref?.attachmentId)
  }
  if (data.kind === 'attachment') {
    return (
      playgroundAttachmentKind(data.mediaType) === 'image' &&
      Boolean(data.ref?.sessionId && data.ref?.attachmentId)
    )
  }
  if (data.kind === 'task-result') {
    return Boolean(data.ref?.taskId)
  }
  return false
}

/**
 * A connected upstream node a step's instruction can reference with `@`. Only
 * directly connected nodes are offered, so a mention can never name a resource
 * the step does not already consume through an edge.
 */
export type CanvasWorkflowMention = {
  nodeId: string
  label: string
  kind: CanvasNodeKind
  /** Whether the mention substitutes text instead of only naming the node. */
  hasText: boolean
  /** Whether the node's bytes become a reference image input. */
  hasImage: boolean
}

/**
 * The upstream nodes a step can reference, in edge order without duplicates.
 */
export function canvasWorkflowMentions(
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasWorkflowMention[] {
  const byID = new Map(nodes.map((item) => [item.id, item]))
  const mentions: CanvasWorkflowMention[] = []
  const seen = new Set<string>()
  for (const edge of edges) {
    if (edge.target !== node.id || seen.has(edge.source)) continue
    const upstream = byID.get(edge.source)
    if (!upstream) continue
    seen.add(edge.source)
    mentions.push({
      nodeId: upstream.id,
      label: canvasWorkflowNodeLabel(upstream.data),
      kind: upstream.data.kind,
      hasText: canvasWorkflowNodeHasText(upstream.data),
      hasImage: canvasWorkflowNodeHasImage(upstream.data),
    })
  }
  return mentions
}

/**
 * The `@` query the caret sits in, or null when it is not inside a mention. A
 * mention starts at the beginning of a line or after whitespace and runs to
 * the caret without another `@`.
 */
export function canvasWorkflowMentionQuery(
  value: string,
  caret: number
): string | null {
  const position = Math.max(0, Math.min(caret, value.length))
  const match = /(?:^|\s)@([^\s@]{0,40})$/.exec(value.slice(0, position))
  return match ? match[1] : null
}

/** Mention candidates matching a query, bounded for the suggestion list. */
export function canvasWorkflowMentionMatches(
  mentions: CanvasWorkflowMention[],
  query: string
): CanvasWorkflowMention[] {
  const needle = query.trim().toLowerCase()
  return mentions
    .filter((mention) => mention.label.toLowerCase().includes(needle))
    .slice(0, CANVAS_WORKFLOW_MENTION_MAX_MATCHES)
}

/**
 * Replaces the active `@query` at the caret with `@label` and reports the new
 * caret position. A caret that is not inside a mention (the picker was opened
 * explicitly) inserts the token there instead. A trailing space keeps a
 * following word separate from the token.
 */
export function insertCanvasWorkflowMention(
  value: string,
  caret: number,
  query: string,
  label: string
): { value: string; caret: number } {
  const position = Math.max(0, Math.min(caret, value.length))
  const tokenStart = position - query.length - 1
  const insideToken =
    tokenStart >= 0 && value.slice(tokenStart, tokenStart + 1) === '@'
  const from = insideToken ? tokenStart : position
  const inserted = `@${label} `
  return {
    value: value.slice(0, from) + inserted + value.slice(position),
    caret: from + inserted.length,
  }
}

/**
 * Substitutes every `@label` mention of one instruction with the referenced
 * node's contribution and reports which nodes were mentioned. Matches run
 * longest label first so a label that prefixes another cannot shadow it, and a
 * label that occurs twice resolves to the same node both times.
 */
function substituteCanvasWorkflowMentions(
  text: string,
  mentions: CanvasWorkflowMention[],
  contribution: (mention: CanvasWorkflowMention) => string
): { text: string; mentioned: Set<string> } {
  const mentioned = new Set<string>()
  if (!text.includes('@')) return { text, mentioned }
  let substituted = text
  const ordered = [...mentions].sort((a, b) => b.label.length - a.label.length)
  for (const mention of ordered) {
    const token = `@${mention.label}`
    if (!substituted.includes(token)) continue
    substituted = substituted.split(token).join(contribution(mention))
    mentioned.add(mention.nodeId)
  }
  return { text: substituted, mentioned }
}

type CanvasWorkflowOrder = { steps: string[] } | { error: string }

/**
 * The subgraph a selection run executes: every selected node, the descendants
 * of selected group boxes, and all ancestors a chosen step still depends on.
 * Edges stay only when both endpoints are inside, so input and reference-image
 * resolution can never read a node outside the run. A cyclic import is bounded
 * by the included set, so the traversal always terminates.
 */
export function canvasWorkflowSelectionScope(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  selectedIds: Iterable<string>
): { nodes: CanvasFlowNode[]; edges: CanvasFlowEdge[] } {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const included = new Set<string>()
  const selected: string[] = []
  for (const id of selectedIds) {
    if (!byID.has(id) || included.has(id)) continue
    included.add(id)
    selected.push(id)
  }

  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    const parentId = node.data.parentId
    if (!parentId || !byID.has(parentId)) continue
    const children = childrenByParent.get(parentId)
    if (children) {
      children.push(node.id)
    } else {
      childrenByParent.set(parentId, [node.id])
    }
  }
  const pendingGroups = selected.filter(
    (id) => byID.get(id)?.data.kind === 'group'
  )
  while (pendingGroups.length > 0) {
    const groupId = pendingGroups.pop() as string
    for (const childId of childrenByParent.get(groupId) ?? []) {
      if (included.has(childId)) continue
      included.add(childId)
      if (byID.get(childId)?.data.kind === 'group') {
        pendingGroups.push(childId)
      }
    }
  }

  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    if (!byID.has(edge.source) || !byID.has(edge.target)) continue
    const sources = incoming.get(edge.target)
    if (sources) {
      sources.push(edge.source)
    } else {
      incoming.set(edge.target, [edge.source])
    }
  }
  const pendingAncestors = [...included]
  while (pendingAncestors.length > 0) {
    const id = pendingAncestors.pop() as string
    for (const sourceId of incoming.get(id) ?? []) {
      if (included.has(sourceId)) continue
      included.add(sourceId)
      pendingAncestors.push(sourceId)
    }
  }

  return {
    nodes: nodes.filter((node) => included.has(node.id)),
    edges: edges.filter(
      (edge) => included.has(edge.source) && included.has(edge.target)
    ),
  }
}

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
  if ('error' in order) return order.error
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
 *
 * An `@label` mention of a connected node places that node's text where the
 * mention stands instead of appending it at the end, so an instruction can
 * reference one resource in the middle of a sentence; a node without text is
 * replaced by its label.
 */
export function resolveCanvasWorkflowInput(
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  outputs: Map<string, string>
): string {
  const byID = new Map(nodes.map((item) => [item.id, item]))
  const connectionText = (nodeId: string, data: CanvasNodeData): string =>
    outputs.get(nodeId)?.trim() || canvasWorkflowNodeText(data)
  const mentions = canvasWorkflowMentions(node, nodes, edges)
  const substituted = substituteCanvasWorkflowMentions(
    node.data.text ?? '',
    mentions,
    (mention) => {
      const upstream = byID.get(mention.nodeId)
      if (!upstream) return mention.label
      return connectionText(mention.nodeId, upstream.data) || mention.label
    }
  )
  const parts: string[] = []
  const own = substituted.text.trim()
  if (own) parts.push(own)
  for (const edge of edges) {
    if (edge.target !== node.id) continue
    const upstream = byID.get(edge.source)
    if (!upstream || substituted.mentioned.has(upstream.id)) continue
    const text = connectionText(upstream.id, upstream.data)
    if (text) parts.push(text)
  }
  return truncateCanvasWorkflowText(
    parts.join('\n\n'),
    CANVAS_WORKFLOW_INPUT_MAX_CHARS
  )
}

/**
 * Where a reference image comes from: an attachment behind the owner-scoped
 * content endpoint, or the artifact of a settled generation task. Only the
 * source is described here; the bytes are read by the caller through the
 * controlled endpoints, so the canvas never stores a URL.
 */
export type CanvasWorkflowImageSource =
  | {
      nodeId: string
      kind: 'attachment'
      sessionId: string
      attachmentId: string
    }
  | {
      nodeId: string
      kind: 'task-result'
      taskId: string
      artifactKey?: string
    }

/**
 * The reference images a step reads from its directly connected upstream
 * nodes, in edge order without duplicates. A source whose node the read path
 * already flagged as deleted is skipped; the bytes of the rest are bounded by
 * the caller before they enter a request.
 */
export function resolveCanvasWorkflowImageSources(
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasWorkflowImageSource[] {
  const byID = new Map(nodes.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const sources: CanvasWorkflowImageSource[] = []
  for (const edge of edges) {
    if (edge.target !== node.id || seen.has(edge.source)) continue
    const upstream = byID.get(edge.source)
    if (!upstream || upstream.data.sourceDeleted === true) continue
    const reference = upstream.data.ref
    const isImageAttachment =
      upstream.data.kind === 'image' ||
      (upstream.data.kind === 'attachment' &&
        playgroundAttachmentKind(upstream.data.mediaType) === 'image')
    if (isImageAttachment && reference?.sessionId && reference.attachmentId) {
      seen.add(upstream.id)
      sources.push({
        nodeId: upstream.id,
        kind: 'attachment',
        sessionId: reference.sessionId,
        attachmentId: reference.attachmentId,
      })
      continue
    }
    if (upstream.data.kind === 'task-result' && reference?.taskId) {
      seen.add(upstream.id)
      sources.push({
        nodeId: upstream.id,
        kind: 'task-result',
        taskId: reference.taskId,
        ...(reference.taskArtifactKey
          ? { artifactKey: reference.taskArtifactKey }
          : {}),
      })
    }
  }
  return sources
}

/**
 * The bounded generation configuration of one `task` step. An imported board
 * can hold any number, so every multiplier is re-bounded here even though the
 * relay validates the request again (`dto.MaxImageN`,
 * `relaycommon.MaxTaskDurationSeconds`).
 */
export type CanvasWorkflowGenerationConfig = {
  generation: CanvasWorkflowGenerationKind
  size?: string
  quality?: string
  imageCount?: number
  duration?: number
}

export function resolveCanvasWorkflowGeneration(
  node: CanvasFlowNode
): CanvasWorkflowGenerationConfig {
  const workflow = node.data.workflow ?? {}
  const generation: CanvasWorkflowGenerationKind =
    workflow.generation === 'video' ? 'video' : 'image'
  const size = workflow.size?.trim()
  if (generation === 'video') {
    return {
      generation,
      ...(size && size in CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS ? { size } : {}),
      ...(Number.isInteger(workflow.duration) &&
      (workflow.duration ?? 0) > 0 &&
      (workflow.duration ?? 0) <= CANVAS_WORKFLOW_DURATION_MAX_SECONDS
        ? { duration: workflow.duration }
        : {}),
    }
  }
  const quality = workflow.quality?.trim()
  const maxCount = Math.max(...CANVAS_WORKFLOW_IMAGE_COUNTS)
  const imageCount = workflow.imageCount
  return {
    generation,
    ...(size && size in CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS ? { size } : {}),
    ...(quality &&
    (CANVAS_WORKFLOW_IMAGE_QUALITIES as readonly string[]).includes(quality)
      ? { quality }
      : {}),
    ...(Number.isInteger(imageCount) &&
    (imageCount ?? 0) > 0 &&
    (imageCount ?? 0) <= maxCount
      ? { imageCount }
      : {}),
  }
}

/** The group a step runs in: its own override first, then the canvas group. */
export function canvasWorkflowGroup(
  node: CanvasFlowNode,
  fallback: string
): string {
  return node.data.workflow?.group?.trim() || fallback
}

/** The step a result node points at, if the board still names one. */
export function canvasWorkflowRetrySource(node: CanvasFlowNode): string | null {
  return node.data.workflow?.sourceNodeId?.trim() || null
}

/**
 * The retry record a result node keeps: the prompt, model, generation
 * parameters and the id of the step that produced it. Nothing here is a URL or
 * a credential, so retrying re-issues the same request through /pg and the
 * server applies its own validation and billing again.
 */
export function canvasWorkflowRetryRecord(
  step: CanvasFlowNode,
  resolved: {
    inputText: string
    group: string
    inputImageCount: number
  }
): CanvasNodeWorkflowState {
  const workflow = step.data.workflow ?? {}
  return {
    status: 'succeeded',
    ...(workflow.model ? { model: workflow.model } : {}),
    ...(workflow.generation ? { generation: workflow.generation } : {}),
    ...(workflow.size ? { size: workflow.size } : {}),
    ...(workflow.quality ? { quality: workflow.quality } : {}),
    ...(workflow.imageCount ? { imageCount: workflow.imageCount } : {}),
    ...(workflow.duration ? { duration: workflow.duration } : {}),
    ...(resolved.group ? { group: resolved.group } : {}),
    ...(resolved.inputText ? { inputText: resolved.inputText } : {}),
    inputImageCount: resolved.inputImageCount,
    sourceNodeId: step.id,
    ...(workflow.attempts ? { attempts: workflow.attempts } : {}),
    updatedAt: Date.now(),
  }
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
