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
  CANVAS_ASSISTANT_CONTEXT_MAX_DEPTH,
  CANVAS_ASSISTANT_CONTEXT_MAX_NODES,
  CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS,
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
  CANVAS_NODE_ADD_OFFSET,
  CANVAS_NODE_KIND_LABELS,
} from '../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasWorkflowGenerationKind,
} from '../types'
import {
  canvasWorkflowNodeHasText,
  canvasWorkflowNodeLabel,
  canvasWorkflowNodeText,
  truncateCanvasWorkflowText,
} from './canvas-workflow'

/**
 * The nodes one assistant request reads as context: the anchor first, then its
 * transitive upstream nodes level by level in edge order. The walk is bounded
 * by depth and node count and by a visited set, so an imported cyclic board can
 * never loop or overshoot the request budget. Without a selection the board's
 * text-bearing nodes stand in, so the assistant still knows what the canvas
 * holds.
 */
export function canvasAssistantContextNodes(
  anchor: CanvasFlowNode | null,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasFlowNode[] {
  if (!anchor) {
    return nodes
      .filter((node) => canvasWorkflowNodeHasText(node.data))
      .slice(0, CANVAS_ASSISTANT_CONTEXT_MAX_NODES)
  }
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const upstreamByTarget = new Map<string, string[]>()
  for (const edge of edges) {
    const upstream = upstreamByTarget.get(edge.target)
    if (upstream) upstream.push(edge.source)
    else upstreamByTarget.set(edge.target, [edge.source])
  }
  const context: CanvasFlowNode[] = []
  const visited = new Set<string>([anchor.id])
  let frontier = [anchor.id]
  for (
    let depth = 0;
    depth < CANVAS_ASSISTANT_CONTEXT_MAX_DEPTH && frontier.length > 0;
    depth++
  ) {
    const next: string[] = []
    for (const id of frontier) {
      const node = byID.get(id)
      if (!node) continue
      if (context.length >= CANVAS_ASSISTANT_CONTEXT_MAX_NODES) return context
      context.push(node)
      for (const sourceId of upstreamByTarget.get(id) ?? []) {
        if (visited.has(sourceId)) continue
        visited.add(sourceId)
        next.push(sourceId)
      }
    }
    frontier = next
  }
  return context
}

/**
 * The system message of one assistant request. Each context node contributes
 * its kind, label, id and a bounded text; media references are described by id
 * only, so no provider URL or credential ever enters a request. The resolved
 * context is re-sent on every turn, so a board edited between turns is answered
 * from its current state.
 */
export function canvasAssistantSystemPrompt(context: CanvasFlowNode[]): string {
  const lines = [
    'You are the assistant inside a node canvas workspace. You help the user refine the text on the canvas, answer questions about it, and compose image or video generation instructions from it.',
    'Answer in the language of the user. Do not invent canvas content that is not described below; the context is bounded and may be truncated.',
  ]
  if (context.length === 0) {
    lines.push('Canvas context: empty; no node carries text yet.')
    return lines.join('\n')
  }
  lines.push('Canvas context:')
  for (const node of context) {
    const kind = CANVAS_NODE_KIND_LABELS[node.data.kind]
    const label = canvasWorkflowNodeLabel(node.data)
    const text = truncateCanvasWorkflowText(
      canvasWorkflowNodeText(node.data),
      CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS
    )
    const title = label === kind ? kind : `${kind} "${label}"`
    lines.push(`- [${node.id}] ${title}${text ? `: ${text}` : ': (no text)'}`)
  }
  return lines.join('\n')
}

/**
 * Where an inserted reply lands: right of the anchor so the new edge stays
 * visible, or at the toolbar's cascade when the board has no selection.
 */
export function canvasAssistantInsertPosition(
  anchor: CanvasFlowNode | null,
  nodes: CanvasFlowNode[]
): { x: number; y: number } {
  if (anchor) {
    return {
      x: anchor.position.x + CANVAS_LINKED_NODE_OFFSET_X,
      y: anchor.position.y,
    }
  }
  const cascade = CANVAS_NODE_ADD_OFFSET * (nodes.length % 8)
  return {
    x: CANVAS_NODE_ADD_BASE + cascade,
    y: CANVAS_NODE_ADD_BASE + cascade,
  }
}

/** Node data of an inserted assistant reply: a plain text node. */
export function canvasAssistantReplyNodeData(
  text: string
): Partial<CanvasNodeData> {
  return { text }
}

/**
 * Node data of a generation step created from an assistant reply. The reply
 * becomes the step's own instruction and the step runs in the requested kind;
 * size, quality, count and duration stay unset so the channel default answers,
 * exactly like a step added from the toolbar. The relay re-validates the
 * resolved request and bills it to the account like any other run.
 */
export function canvasAssistantTaskNodeData(
  model: string,
  generation: CanvasWorkflowGenerationKind,
  instruction: string
): Partial<CanvasNodeData> {
  return {
    text: instruction,
    workflow: { model, generation },
  }
}
