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
import { nanoid } from 'nanoid'

import {
  CANVAS_GROUP_MAX_DEPTH,
  CANVAS_GROUP_PADDING,
  CANVAS_MAX_EDGES,
  CANVAS_MAX_NODES,
  CANVAS_NODE_ESTIMATED_HEIGHT,
  CANVAS_NODE_ESTIMATED_WIDTH,
  CANVAS_PASTE_OFFSET,
} from '../constants'
import type { CanvasFlowEdge, CanvasFlowNode } from '../types'
import {
  canvasNodeDataWithParent,
  orderCanvasNodesForFlow,
} from './canvas-document'

/** An editor-local clipboard of copied nodes and the edges between them. */
export interface CanvasClipboard {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
}

export interface CanvasGraph {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
}

export function canvasNodeKind(node: CanvasFlowNode): string {
  return node.data.kind ?? node.type ?? 'text'
}

/**
 * The position of a node in canvas coordinates. A grouped node stores its
 * position relative to its parent, so walking the parent chain reconstructs the
 * absolute place a copy or an ungroup drops it at. A depth bound keeps an
 * imported cyclic document from looping.
 */
export function canvasAbsolutePosition(
  node: CanvasFlowNode,
  byId: Map<string, CanvasFlowNode>
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  for (let depth = 0; parentId && depth < CANVAS_GROUP_MAX_DEPTH; depth++) {
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * Copies the selected nodes plus the edges between them. A node whose group is
 * not part of the selection is copied un-parented at its absolute position, so
 * a pasted node can never point at a group that was not copied.
 */
export function canvasCopySelection(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasClipboard | null {
  const selected = nodes.filter((node) => node.selected === true)
  if (selected.length === 0) return null
  const selectedIds = new Set(selected.map((node) => node.id))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const copied = selected.map((node) => {
    const parentCopied = node.parentId ? selectedIds.has(node.parentId) : false
    if (parentCopied) {
      return { ...node, selected: false }
    }
    return {
      ...node,
      selected: false,
      parentId: undefined,
      extent: undefined,
      expandParent: undefined,
      position: canvasAbsolutePosition(node, byId),
      data: canvasNodeDataWithParent(node.data),
    }
  })
  return {
    nodes: copied,
    edges: edges.filter(
      (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)
    ),
  }
}

/**
 * Pastes a copy of the clipboard into the graph: every node gets a fresh id,
 * the edges between the copies are rebuilt against those ids, and the whole
 * selection moves by one offset. A copied group keeps its children relative to
 * it, so the pasted cluster moves as one unit. The paste is refused as a whole
 * when it would exceed the node or edge budget.
 */
export function canvasPasteClipboard(
  clipboard: CanvasClipboard,
  graph: CanvasGraph,
  offset: number = CANVAS_PASTE_OFFSET
): CanvasGraph | null {
  if (clipboard.nodes.length === 0) return null
  if (graph.nodes.length + clipboard.nodes.length > CANVAS_MAX_NODES) {
    return null
  }
  if (graph.edges.length + clipboard.edges.length > CANVAS_MAX_EDGES) {
    return null
  }
  const idMap = new Map<string, string>()
  for (const node of clipboard.nodes) {
    idMap.set(node.id, nanoid())
  }
  const pasted = clipboard.nodes.map((node) => {
    const id = idMap.get(node.id) as string
    const parentId =
      node.parentId && idMap.has(node.parentId)
        ? idMap.get(node.parentId)
        : undefined
    return {
      ...node,
      id,
      selected: true,
      ...(parentId
        ? { parentId }
        : {
            parentId: undefined,
            extent: undefined,
            expandParent: undefined,
            position: {
              x: node.position.x + offset,
              y: node.position.y + offset,
            },
          }),
      data: canvasNodeDataWithParent(node.data, parentId),
    }
  })
  const pastedEdges = clipboard.edges.map((edge) => ({
    ...edge,
    id: nanoid(),
    source: idMap.get(edge.source) as string,
    target: idMap.get(edge.target) as string,
  }))
  return {
    nodes: [
      ...graph.nodes.map((node) =>
        node.selected === true ? { ...node, selected: false } : node
      ),
      ...orderCanvasNodesForFlow(pasted),
    ],
    edges: [...graph.edges, ...pastedEdges],
  }
}

/** Selects every node; a later drag or press replaces the selection again. */
export function canvasSelectAll(nodes: CanvasFlowNode[]): CanvasFlowNode[] {
  if (nodes.every((node) => node.selected === true)) return nodes
  return nodes.map((node) =>
    node.selected === true ? node : { ...node, selected: true }
  )
}

/**
 * Wraps the selected nodes into a new `group` node: the box is placed around
 * their combined footprint with padding, the nodes move inside it with
 * positions relative to the box, and the box itself is selected. Existing
 * parents are re-parented, but a selected group is refused so the editor never
 * builds a group inside a group.
 */
export function canvasGroupSelection(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): (CanvasGraph & { groupId: string }) | null {
  const selected = nodes.filter((node) => node.selected === true)
  if (selected.length === 0) return null
  if (selected.some((node) => canvasNodeKind(node) === 'group')) return null
  if (nodes.length >= CANVAS_MAX_NODES) return null
  const selectedIds = new Set(selected.map((node) => node.id))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of selected) {
    const absolute = canvasAbsolutePosition(node, byId)
    const width =
      node.width ?? node.measured?.width ?? CANVAS_NODE_ESTIMATED_WIDTH
    const height =
      node.height ?? node.measured?.height ?? CANVAS_NODE_ESTIMATED_HEIGHT
    minX = Math.min(minX, absolute.x)
    minY = Math.min(minY, absolute.y)
    maxX = Math.max(maxX, absolute.x + width)
    maxY = Math.max(maxY, absolute.y + height)
  }
  const groupId = nanoid()
  const position = {
    x: minX - CANVAS_GROUP_PADDING,
    y: minY - CANVAS_GROUP_PADDING,
  }
  const group: CanvasFlowNode = {
    id: groupId,
    type: 'group',
    position,
    width: maxX - minX + 2 * CANVAS_GROUP_PADDING,
    height: maxY - minY + 2 * CANVAS_GROUP_PADDING,
    selected: true,
    data: { kind: 'group' },
  }
  const grouped: CanvasFlowNode[] = []
  let inserted = false
  for (const node of nodes) {
    if (!selectedIds.has(node.id)) {
      grouped.push(node)
      continue
    }
    if (!inserted) {
      // xyflow requires a parent before its children.
      grouped.push(group)
      inserted = true
    }
    const absolute = canvasAbsolutePosition(node, byId)
    // The box becomes the selection: a second group command refuses to wrap a
    // group, so the children step out of the way instead of staying selected.
    grouped.push({
      ...node,
      selected: false,
      parentId: groupId,
      extent: 'parent',
      expandParent: true,
      position: { x: absolute.x - position.x, y: absolute.y - position.y },
      data: canvasNodeDataWithParent(node.data, groupId),
    })
  }
  if (!inserted) grouped.push(group)
  return { nodes: grouped, edges, groupId }
}

/**
 * Releases grouped nodes: every selected child returns to absolute coordinates,
 * and a selected group node is removed together with its edges while its
 * remaining children are released too. Returns null when the selection contains
 * neither a group nor a grouped node.
 */
export function canvasUngroupSelection(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
): CanvasGraph | null {
  const selectedIds = new Set(
    nodes.filter((node) => node.selected === true).map((node) => node.id)
  )
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const groupIds = new Set(
    nodes
      .filter(
        (node) => selectedIds.has(node.id) && canvasNodeKind(node) === 'group'
      )
      .map((node) => node.id)
  )
  const released = new Set<string>()
  for (const node of nodes) {
    if (node.parentId && selectedIds.has(node.id)) released.add(node.id)
    if (node.parentId && groupIds.has(node.parentId)) released.add(node.id)
  }
  if (groupIds.size === 0 && released.size === 0) return null

  const nextNodes: CanvasFlowNode[] = []
  for (const node of nodes) {
    if (groupIds.has(node.id)) continue
    if (!released.has(node.id)) {
      nextNodes.push(node)
      continue
    }
    nextNodes.push({
      id: node.id,
      type: node.type,
      position: canvasAbsolutePosition(node, byId),
      selected: true,
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      data: canvasNodeDataWithParent(node.data),
    })
  }
  return {
    nodes: nextNodes,
    edges: edges.filter(
      (edge) => !groupIds.has(edge.source) && !groupIds.has(edge.target)
    ),
  }
}

/**
 * Expands a removal to the children of a deleted group: deleting a box must not
 * leave nodes pointing at a parent that is gone. Nested groups are followed to
 * the depth bound.
 */
export function canvasExpandRemovedNodes(
  nodes: CanvasFlowNode[],
  removedIds: Set<string>
): Set<string> {
  if (removedIds.size === 0) return removedIds
  let expanded = new Set(removedIds)
  for (let depth = 0; depth < CANVAS_GROUP_MAX_DEPTH; depth++) {
    let changed = false
    for (const node of nodes) {
      if (!node.parentId || expanded.has(node.id)) continue
      if (expanded.has(node.parentId)) {
        expanded.add(node.id)
        changed = true
      }
    }
    if (!changed) break
  }
  return expanded
}
