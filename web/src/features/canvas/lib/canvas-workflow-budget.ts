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
import { estimateTextTokens } from '@/features/playground/lib/context/playground-context'

import type { CanvasFlowEdge, CanvasFlowNode } from '../types'
import {
  canvasWorkflowGroup,
  isCanvasWorkflowStep,
  resolveCanvasWorkflowGeneration,
  resolveCanvasWorkflowInput,
} from './canvas-workflow'

/** The server bound on one step's client-supplied prompt-token estimate. */
export const CANVAS_WORKFLOW_BUDGET_TOKEN_MAX = 2_000_000
/** The server bound on the number of steps one estimate request may carry. */
export const CANVAS_WORKFLOW_BUDGET_STEP_MAX = 64

/** One step of a planned run, as the estimate endpoint expects it. */
export interface CanvasWorkflowEstimateStepInput {
  nodeId: string
  /** Billing path of the node: text model, image generation or a task. */
  kind: 'chat' | 'image' | 'video'
  model: string
  /** Prompt-token estimate; the server bounds it again. */
  tokens: number
  /** The group the step's real request would run in. */
  group: string
  count?: number
  size?: string
  quality?: string
}

/**
 * Builds the estimate request of one planned run: the executed steps in run
 * order, each with the model, group override and generation parameters its
 * real request would send. Prompt tokens are measured from the text the step
 * resolves today, because the upstream outputs of a run that has not happened
 * yet do not exist; the estimate is therefore a lower bound the run may exceed.
 */
export function canvasWorkflowEstimateSteps(
  stepIds: string[],
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  canvasGroup: string
): CanvasWorkflowEstimateStepInput[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const steps: CanvasWorkflowEstimateStepInput[] = []
  for (const id of stepIds) {
    const node = byId.get(id)
    if (!node || !isCanvasWorkflowStep(node.data.kind)) continue
    const model = node.data.workflow?.model?.trim() ?? ''
    if (!model) continue
    const group = canvasWorkflowGroup(node, canvasGroup)
    const input = resolveCanvasWorkflowInput(node, nodes, edges, new Map())
    const tokens = Math.min(
      estimateTextTokens(input),
      CANVAS_WORKFLOW_BUDGET_TOKEN_MAX
    )
    if (node.data.kind === 'model') {
      steps.push({ nodeId: node.id, kind: 'chat', model, tokens, group })
      continue
    }
    const config = resolveCanvasWorkflowGeneration(node)
    if (config.generation === 'video') {
      steps.push({ nodeId: node.id, kind: 'video', model, tokens, group })
      continue
    }
    steps.push({
      nodeId: node.id,
      kind: 'image',
      model,
      tokens,
      group,
      ...(config.imageCount ? { count: config.imageCount } : {}),
      ...(config.size ? { size: config.size } : {}),
      ...(config.quality ? { quality: config.quality } : {}),
    })
  }
  return steps
}
