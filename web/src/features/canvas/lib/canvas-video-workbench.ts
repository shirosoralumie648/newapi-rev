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
import { CANVAS_NODE_ADD_BASE } from '../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
} from '../types'
import {
  canvasWorkflowOutputTargets,
  canvasWorkflowPreferredResultId,
  isCanvasWorkflowResult,
} from './canvas-workflow'

/**
 * One playable result of the active video step. The version strip reads the
 * retry record of each `video` node: it names the concrete seed, model, size
 * and duration the attempt sent, while the node ref names the task artifact
 * the controlled content endpoint plays.
 */
export type CanvasVideoWorkbenchVariant = {
  node: CanvasFlowNode
  seed?: number
  model?: string
  size?: string
  duration?: number
  preferred: boolean
}

/** One node the workbench adds when it opens an empty video project. */
export type CanvasVideoWorkbenchNode = {
  kind: CanvasNodeKind
  position: { x: number; y: number }
  data?: Partial<CanvasNodeData>
}

/** The task artifact the main player shows. It never carries a stored URL. */
export type CanvasVideoWorkbenchSource = {
  taskId: string
  artifactKey?: string
}

/**
 * The step the workbench focuses: the first video generation step in reading
 * order. Image steps stay on their own workbench, and a board with several
 * video steps keeps the top-left one so the layout never jumps between
 * renders.
 */
export function canvasVideoWorkbenchStep(
  nodes: CanvasFlowNode[]
): CanvasFlowNode | null {
  const steps = nodes
    .filter(
      (node) =>
        node.data.kind === 'task' && node.data.workflow?.generation === 'video'
    )
    .sort(
      (left, right) =>
        left.position.y - right.position.y || left.position.x - right.position.x
    )
  return steps[0] ?? null
}

/**
 * The versions and batch variants of one video step, in edge order. A result
 * whose edge was deleted but whose retry record still names the step stays in
 * the strip, exactly like the image workbench bloodline. Only playable `video`
 * nodes qualify: an image result of an earlier configuration must not become
 * the main player or the preferred downstream result.
 */
export function canvasVideoWorkbenchVariants(
  stepId: string,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasVideoWorkbenchVariant[] {
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const id of canvasWorkflowOutputTargets(stepId, nodes, edges)) add(id)
  for (const node of nodes) {
    if (!isCanvasWorkflowResult(node.data.kind)) continue
    if (node.data.workflow?.sourceNodeId?.trim() !== stepId) continue
    add(node.id)
  }
  const preferredId = canvasWorkflowPreferredResultId(stepId, nodes)
  return ids.flatMap((id) => {
    const node = byID.get(id)
    if (!node || node.data.kind !== 'video' || !node.data.ref?.taskId) return []
    const workflow = node.data.workflow
    const seed =
      typeof workflow?.seed === 'number'
        ? workflow.seed
        : typeof workflow?.lastSeed === 'number'
          ? workflow.lastSeed
          : undefined
    return [
      {
        node,
        ...(seed === undefined ? {} : { seed }),
        ...(workflow?.model ? { model: workflow.model } : {}),
        ...(workflow?.size ? { size: workflow.size } : {}),
        ...(workflow?.duration ? { duration: workflow.duration } : {}),
        preferred:
          preferredId === id ||
          (preferredId === null && workflow?.preferred === true),
      },
    ]
  })
}

/**
 * The artifact the main player should play: the preferred variant, or the last
 * recorded one when no variant is flagged. A step that settled before its
 * result node was saved still exposes its durable task id, so the player can
 * fall back to the first video artifact of that task.
 */
export function canvasVideoWorkbenchSource(
  step: CanvasFlowNode | null,
  variants: CanvasVideoWorkbenchVariant[]
): CanvasVideoWorkbenchSource | null {
  const variant =
    variants.find((item) => item.preferred) ??
    variants[variants.length - 1] ??
    null
  const reference = variant?.node.data.ref
  if (reference?.taskId) {
    return {
      taskId: reference.taskId,
      ...(reference.taskArtifactKey
        ? { artifactKey: reference.taskArtifactKey }
        : {}),
    }
  }
  const taskId = step?.data.workflow?.taskId
  return taskId ? { taskId } : null
}

/** The step node the workbench creates for an empty video project. */
export function canvasVideoWorkbenchDefaultStep(): CanvasVideoWorkbenchNode {
  return {
    kind: 'task',
    position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
    data: { workflow: { generation: 'video' } },
  }
}

/**
 * The version label of one variant: the result node's own label plus the
 * concrete seed its retry record kept. The component translates the label;
 * the seed is a number and needs no translation.
 */
export function canvasVideoWorkbenchVariantLabel(
  variant: CanvasVideoWorkbenchVariant,
  label: string
): string {
  return variant.seed === undefined ? label : `${label} · ${variant.seed}`
}
