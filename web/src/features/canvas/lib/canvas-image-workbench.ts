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
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
  CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
} from '../constants'
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
 * One result of the active image step. The workbench's version strip is built
 * from these: the retry record written on a `task-result` node (its concrete
 * seed, model and size) is the label source, and its preferred flag decides
 * which member is the main image.
 */
export type CanvasImageWorkbenchVariant = {
  node: CanvasFlowNode
  /** The seed the attempt actually sent, when the record has one. */
  seed?: number
  model?: string
  size?: string
  preferred: boolean
}

/** One node the workbench adds when it opens an empty image project. */
export type CanvasImageWorkbenchNode = {
  kind: CanvasNodeKind
  position: { x: number; y: number }
  data?: Partial<CanvasNodeData>
}

/** One node a pin-to-canvas action lays out and marks as affixed. */
export type CanvasImageWorkbenchAffixPlacement = {
  id: string
  position: { x: number; y: number }
  data: Partial<CanvasNodeData>
}

/** Vertical room a pinned row leaves below the rest of the board. */
export const CANVAS_IMAGE_WORKBENCH_AFFIX_GAP = 48

/**
 * The step the workbench focuses: the first image generation step in reading
 * order. A workbench project is created for one image bloodline; when a board
 * still holds several steps the top-left one is the stable choice, so the
 * layout never jumps between renders.
 */
export function canvasImageWorkbenchStep(
  nodes: CanvasFlowNode[]
): CanvasFlowNode | null {
  const steps = nodes
    .filter(
      (node) =>
        node.data.kind === 'task' && node.data.workflow?.generation !== 'video'
    )
    .sort(
      (left, right) =>
        left.position.y - right.position.y || left.position.x - right.position.x
    )
  return steps[0] ?? null
}

/**
 * The versions and batch variants of one step's bloodline, in edge order. A
 * result whose connecting edge was deleted but whose retry record still names
 * the step stays in the strip: it is the same bloodline and remains a valid
 * "switch the main image" target.
 */
export function canvasImageWorkbenchVariants(
  stepId: string,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasImageWorkbenchVariant[] {
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
    if (!node) return []
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
        preferred:
          preferredId === id ||
          (preferredId === null && workflow?.preferred === true),
      },
    ]
  })
}

/** The step node the workbench creates for an empty image project. */
export function canvasImageWorkbenchDefaultStep(): CanvasImageWorkbenchNode {
  return {
    kind: 'task',
    position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
    data: { workflow: { generation: 'image' } },
  }
}

/**
 * Lays the current bloodline out in one row below every other node and marks
 * it affixed. Nodes outside the bloodline are ignored when the row is placed,
 * so pinning the same result twice is stable instead of pushing the row
 * further down the board on each click.
 */
export function canvasImageWorkbenchAffixPlacements(
  step: CanvasFlowNode,
  variants: CanvasImageWorkbenchVariant[],
  nodes: CanvasFlowNode[]
): CanvasImageWorkbenchAffixPlacement[] {
  const bloodline = new Set([step.id, ...variants.map((item) => item.node.id)])
  const others = nodes.filter((node) => !bloodline.has(node.id))
  const top =
    others.length > 0
      ? Math.max(...others.map((node) => node.position.y))
      : step.position.y
  const y =
    top +
    CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y +
    CANVAS_IMAGE_WORKBENCH_AFFIX_GAP
  const placements: CanvasImageWorkbenchAffixPlacement[] = [
    {
      id: step.id,
      position: { x: step.position.x, y },
      data: { affixed: true },
    },
  ]
  variants.forEach((variant, index) => {
    placements.push({
      id: variant.node.id,
      position: {
        x: step.position.x + CANVAS_LINKED_NODE_OFFSET_X * (index + 1),
        y,
      },
      data: { affixed: true },
    })
  })
  return placements
}

/**
 * The version label of one variant: the result node's own label plus the
 * concrete seed its retry record kept. The component translates the label;
 * the seed is a number and needs no translation.
 */
export function canvasImageWorkbenchVariantLabel(
  variant: CanvasImageWorkbenchVariant,
  label: string
): string {
  return variant.seed === undefined ? label : `${label} · ${variant.seed}`
}
