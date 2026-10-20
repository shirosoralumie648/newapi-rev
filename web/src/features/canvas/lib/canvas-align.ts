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
  CANVAS_ALIGN_MIN_GAP,
  CANVAS_ALIGN_SNAP_THRESHOLD,
  CANVAS_AUTO_LAYOUT_GAP_X,
  CANVAS_AUTO_LAYOUT_GAP_Y,
  CANVAS_FRAME_HEADER_HEIGHT,
  CANVAS_FRAME_MIN_HEIGHT,
  CANVAS_FRAME_MIN_WIDTH,
  CANVAS_FRAME_PADDING,
  CANVAS_GROUP_MAX_DEPTH,
  CANVAS_NODE_ESTIMATED_HEIGHT,
  CANVAS_NODE_ESTIMATED_WIDTH,
} from '../constants'
import type { CanvasFlowNode } from '../types'
import {
  canvasAbsolutePosition,
  canvasDescendantIds,
  canvasNodeKind,
  canvasSelectedTopLevel,
} from './canvas-edit'

/** An axis-aligned rectangle in canvas coordinates. */
export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One visual guide while dragging. `axis: 'x'` is a vertical line at `position`
 * spanning `start`..`end` on the y axis; `axis: 'y'` is the horizontal
 * counterpart. `kind: 'gap'` marks an equal-spacing measurement and carries the
 * shared gap size.
 */
export interface CanvasAlignmentGuide {
  axis: 'x' | 'y'
  kind: 'align' | 'gap'
  position: number
  start: number
  end: number
  gap?: number
}

export interface CanvasAlignmentSnap {
  dx: number
  dy: number
  guides: CanvasAlignmentGuide[]
}

export type CanvasDistributeAxis = 'horizontal' | 'vertical'

interface AxisCandidate {
  delta: number
  guides: CanvasAlignmentGuide[]
}

function nodeSize(node: CanvasFlowNode): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? CANVAS_NODE_ESTIMATED_WIDTH,
    height:
      node.measured?.height ?? node.height ?? CANVAS_NODE_ESTIMATED_HEIGHT,
  }
}

/** The node rectangle in canvas coordinates, including its group offset. */
export function canvasNodeRect(
  node: CanvasFlowNode,
  byId: Map<string, CanvasFlowNode>
): CanvasRect {
  const position = canvasAbsolutePosition(node, byId)
  const size = nodeSize(node)
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  }
}

/** The union of the given rectangles, or null for an empty list. */
export function canvasUnionRect(rects: CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function canvasRectsOverlap(
  a: CanvasRect,
  b: CanvasRect,
  axis: 'x' | 'y'
): boolean {
  if (axis === 'x') {
    return a.y < b.y + b.height && a.y + a.height > b.y
  }
  return a.x < b.x + b.width && a.x + a.width > b.x
}

function axisStart(rect: CanvasRect, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.x : rect.y
}

function axisSize(rect: CanvasRect, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.width : rect.height
}

function crossStart(rect: CanvasRect, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.y : rect.x
}

function crossSize(rect: CanvasRect, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.height : rect.width
}

function alignmentGuide(
  axis: 'x' | 'y',
  position: number,
  moving: CanvasRect,
  target: CanvasRect,
  targets: CanvasRect[]
): CanvasAlignmentGuide {
  let start = Math.min(crossStart(moving, axis), crossStart(target, axis))
  let end = Math.max(
    crossStart(moving, axis) + crossSize(moving, axis),
    crossStart(target, axis) + crossSize(target, axis)
  )
  // Extend a guide across every other node that shares the same line, so a row
  // of aligned cards reads as one guide instead of many short segments.
  for (const other of targets) {
    const otherLines = [
      axisStart(other, axis),
      axisStart(other, axis) + axisSize(other, axis) / 2,
      axisStart(other, axis) + axisSize(other, axis),
    ]
    if (!otherLines.some((line) => Math.abs(line - position) < 0.5)) continue
    start = Math.min(start, crossStart(other, axis))
    end = Math.max(end, crossStart(other, axis) + crossSize(other, axis))
  }
  return { axis, kind: 'align', position, start, end }
}

function alignmentCandidate(
  moving: CanvasRect,
  targets: CanvasRect[],
  axis: 'x' | 'y',
  threshold: number
): AxisCandidate | null {
  const movingStart = axisStart(moving, axis)
  const movingSize = axisSize(moving, axis)
  const movingLines = [
    movingStart,
    movingStart + movingSize / 2,
    movingStart + movingSize,
  ]
  let best: AxisCandidate | null = null
  for (const target of targets) {
    const targetStart = axisStart(target, axis)
    const targetSize = axisSize(target, axis)
    const targetLines = [
      targetStart,
      targetStart + targetSize / 2,
      targetStart + targetSize,
    ]
    for (const movingLine of movingLines) {
      for (const targetLine of targetLines) {
        const delta = targetLine - movingLine
        if (Math.abs(delta) > threshold) continue
        if (best && Math.abs(delta) >= Math.abs(best.delta)) continue
        best = {
          delta,
          guides: [alignmentGuide(axis, targetLine, moving, target, targets)],
        }
      }
    }
  }
  return best
}

interface GapPair {
  gap: number
  first: CanvasRect
  second: CanvasRect
}

function referenceGaps(targets: CanvasRect[], axis: 'x' | 'y'): GapPair[] {
  const sorted = [...targets].sort(
    (a, b) => axisStart(a, axis) - axisStart(b, axis)
  )
  const gaps: GapPair[] = []
  for (let index = 0; index < sorted.length; index += 1) {
    const first = sorted[index]
    const firstEnd = axisStart(first, axis) + axisSize(first, axis)
    for (let next = index + 1; next < sorted.length; next += 1) {
      const second = sorted[next]
      const gap = axisStart(second, axis) - firstEnd
      if (gap < CANVAS_ALIGN_MIN_GAP) continue
      if (!canvasRectsOverlap(first, second, axis)) continue
      gaps.push({ gap, first, second })
      break
    }
  }
  return gaps
}

function gapGuide(
  axis: 'x' | 'y',
  first: CanvasRect,
  second: CanvasRect,
  gap: number
): CanvasAlignmentGuide {
  const start = crossStart(first, axis)
  const end = Math.max(
    crossStart(first, axis) + crossSize(first, axis),
    crossStart(second, axis) + crossSize(second, axis)
  )
  return {
    axis,
    kind: 'gap',
    position: axisStart(first, axis) + axisSize(first, axis) + gap / 2,
    start,
    end,
    gap,
  }
}

function gapCandidate(
  moving: CanvasRect,
  targets: CanvasRect[],
  axis: 'x' | 'y',
  threshold: number
): AxisCandidate | null {
  const references = referenceGaps(targets, axis)
  if (references.length === 0) return null
  const movingStart = axisStart(moving, axis)
  const movingEnd = movingStart + axisSize(moving, axis)
  let best: AxisCandidate | null = null
  for (const target of targets) {
    if (!canvasRectsOverlap(moving, target, axis)) continue
    const targetStart = axisStart(target, axis)
    const targetEnd = targetStart + axisSize(target, axis)
    const movingRightGap = targetStart - movingEnd
    const movingLeftGap = movingStart - targetEnd
    for (const reference of references) {
      let delta: number | null = null
      let movingGuide: CanvasAlignmentGuide | null = null
      if (movingRightGap >= CANVAS_ALIGN_MIN_GAP) {
        delta = reference.gap - movingRightGap
        const aligned: CanvasRect =
          axis === 'x'
            ? { ...moving, x: moving.x + delta }
            : { ...moving, y: moving.y + delta }
        movingGuide = gapGuide(axis, aligned, target, reference.gap)
      } else if (movingLeftGap >= CANVAS_ALIGN_MIN_GAP) {
        delta = reference.gap - movingLeftGap
        const aligned: CanvasRect =
          axis === 'x'
            ? { ...moving, x: moving.x + delta }
            : { ...moving, y: moving.y + delta }
        movingGuide = gapGuide(axis, target, aligned, reference.gap)
      }
      if (delta === null || movingGuide === null) continue
      if (Math.abs(delta) > threshold) continue
      if (best && Math.abs(delta) >= Math.abs(best.delta)) continue
      best = {
        delta,
        guides: [
          movingGuide,
          gapGuide(axis, reference.first, reference.second, reference.gap),
        ],
      }
    }
  }
  return best
}

function bestAxisCandidate(
  moving: CanvasRect,
  targets: CanvasRect[],
  axis: 'x' | 'y',
  threshold: number
): AxisCandidate | null {
  const alignment = alignmentCandidate(moving, targets, axis, threshold)
  const gap = gapCandidate(moving, targets, axis, threshold)
  if (!alignment) return gap
  if (!gap) return alignment
  return Math.abs(gap.delta) < Math.abs(alignment.delta) ? gap : alignment
}

/**
 * Snaps a moving rectangle to the edges, centers or equal gaps of stationary
 * rectangles. The returned delta is applied by the caller; the guides are pure
 * geometry in canvas coordinates.
 */
export function canvasAlignmentSnap(
  moving: CanvasRect,
  targets: CanvasRect[],
  threshold: number = CANVAS_ALIGN_SNAP_THRESHOLD
): CanvasAlignmentSnap {
  const x = bestAxisCandidate(moving, targets, 'x', threshold)
  const y = bestAxisCandidate(moving, targets, 'y', threshold)
  const guides: CanvasAlignmentGuide[] = []
  if (x) guides.push(...x.guides)
  if (y) guides.push(...y.guides)
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    guides,
  }
}

/** The selected nodes whose parent is not selected, for a single movement. */
export function canvasNudgeSelection(
  nodes: CanvasFlowNode[],
  dx: number,
  dy: number
): CanvasFlowNode[] | null {
  const moving = canvasSelectedTopLevel(nodes)
  if (moving.length === 0 || (dx === 0 && dy === 0)) return null
  const movingIds = new Set(moving.map((node) => node.id))
  return nodes.map((node) =>
    movingIds.has(node.id)
      ? {
          ...node,
          position: { x: node.position.x + dx, y: node.position.y + dy },
        }
      : node
  )
}

/**
 * Evenly distributes three or more selected top-level nodes between the first
 * and last node on the axis. Endpoints stay put; interior nodes get an equal
 * gap (which may be negative for an overlapping selection).
 */
export function canvasDistributeSelection(
  nodes: CanvasFlowNode[],
  axis: CanvasDistributeAxis
): CanvasFlowNode[] | null {
  const selected = canvasSelectedTopLevel(nodes)
  if (selected.length < 3) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const rects = selected.map((node) => ({
    node,
    rect: canvasNodeRect(node, byId),
  }))
  const flowAxis: 'x' | 'y' = axis === 'horizontal' ? 'x' : 'y'
  rects.sort(
    (a, b) =>
      axisStart(a.rect, flowAxis) - axisStart(b.rect, flowAxis) ||
      a.node.id.localeCompare(b.node.id)
  )
  const first = rects[0]
  const last = rects[rects.length - 1]
  const spanStart = axisStart(first.rect, flowAxis)
  const spanEnd = axisStart(last.rect, flowAxis) + axisSize(last.rect, flowAxis)
  const totalSize = rects.reduce(
    (sum, entry) => sum + axisSize(entry.rect, flowAxis),
    0
  )
  const gap = (spanEnd - spanStart - totalSize) / (rects.length - 1)
  const positions = new Map<string, number>()
  let cursor = spanStart
  for (let index = 0; index < rects.length; index += 1) {
    const entry = rects[index]
    if (index === 0) {
      positions.set(entry.node.id, axisStart(entry.rect, flowAxis))
    } else if (index === rects.length - 1) {
      positions.set(entry.node.id, spanEnd - axisSize(entry.rect, flowAxis))
    } else {
      positions.set(entry.node.id, cursor)
    }
    cursor =
      (positions.get(entry.node.id) ?? cursor) +
      axisSize(entry.rect, flowAxis) +
      gap
  }
  let changed = false
  const nextNodes = nodes.map((node) => {
    const absolute = positions.get(node.id)
    if (absolute === undefined) return node
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const parentPosition = parent
      ? canvasAbsolutePosition(parent, byId)
      : { x: 0, y: 0 }
    const currentAbsolute =
      flowAxis === 'x'
        ? node.position.x + parentPosition.x
        : node.position.y + parentPosition.y
    if (Math.abs(currentAbsolute - absolute) < 0.01) return node
    changed = true
    return {
      ...node,
      position:
        flowAxis === 'x'
          ? { ...node.position, x: absolute - parentPosition.x }
          : { ...node.position, y: absolute - parentPosition.y },
    }
  })
  return changed ? nextNodes : null
}

export type CanvasAlignAxis =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'

export type CanvasAutoLayoutDirection = 'horizontal' | 'vertical'

/**
 * Aligns two or more selected top-level nodes inside their combined bounds.
 * Groups and frames move as one unit; the cross axis is left untouched.
 */
export function canvasAlignSelection(
  nodes: CanvasFlowNode[],
  alignment: CanvasAlignAxis
): CanvasFlowNode[] | null {
  const selected = canvasSelectedTopLevel(nodes).filter(
    (node) => node.hidden !== true
  )
  if (selected.length < 2) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const entries = selected.map((node) => ({
    node,
    rect: canvasNodeRect(node, byId),
  }))
  const bounds = canvasUnionRect(entries.map((entry) => entry.rect))
  if (!bounds) return null
  const desired = new Map<string, { x?: number; y?: number }>()
  for (const entry of entries) {
    const target: { x?: number; y?: number } = {}
    if (alignment === 'left') target.x = bounds.x
    else if (alignment === 'right') {
      target.x = bounds.x + bounds.width - entry.rect.width
    } else if (alignment === 'center') {
      target.x = bounds.x + (bounds.width - entry.rect.width) / 2
    } else if (alignment === 'top') target.y = bounds.y
    else if (alignment === 'bottom') {
      target.y = bounds.y + bounds.height - entry.rect.height
    } else {
      target.y = bounds.y + (bounds.height - entry.rect.height) / 2
    }
    desired.set(entry.node.id, target)
  }
  let changed = false
  const nextNodes = nodes.map((node) => {
    const target = desired.get(node.id)
    if (!target) return node
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    const parentPosition = parent
      ? canvasAbsolutePosition(parent, byId)
      : { x: 0, y: 0 }
    const x =
      target.x === undefined ? node.position.x : target.x - parentPosition.x
    const y =
      target.y === undefined ? node.position.y : target.y - parentPosition.y
    if (
      Math.abs(node.position.x - x) < 0.01 &&
      Math.abs(node.position.y - y) < 0.01
    ) {
      return node
    }
    changed = true
    return { ...node, position: { x, y } }
  })
  return changed ? nextNodes : null
}

/**
 * Nodes geometrically contained by the named frames. A frame is a visual
 * region rather than a parent, so membership is derived from the live
 * rectangles and never stored on a node.
 */
export function canvasFrameMemberIds(
  nodes: CanvasFlowNode[],
  frameIds: Iterable<string>
): Set<string> {
  const requested = new Set(frameIds)
  const members = new Set<string>()
  if (requested.size === 0) return members
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const frames = nodes
    .filter(
      (node) =>
        requested.has(node.id) &&
        node.hidden !== true &&
        canvasNodeKind(node) === 'frame'
    )
    .map((node) => canvasNodeRect(node, byId))
  if (frames.length === 0) return members
  for (const node of nodes) {
    if (
      node.hidden === true ||
      requested.has(node.id) ||
      canvasNodeKind(node) === 'frame'
    ) {
      continue
    }
    const rect = canvasNodeRect(node, byId)
    const contained = frames.some(
      (frame) =>
        rect.x >= frame.x - 0.5 &&
        rect.y >= frame.y - 0.5 &&
        rect.x + rect.width <= frame.x + frame.width + 0.5 &&
        rect.y + rect.height <= frame.y + frame.height + 0.5
    )
    if (contained) members.add(node.id)
  }
  return members
}

/**
 * Expands a set of selected roots for export: descendants of a group travel
 * with the group, and a selected frame carries every node geometrically inside
 * it. A frame therefore never exports as an empty outline. This is the shared
 * id contract for PNG preview and the server archive export.
 */
export function canvasSelectionExportIds(
  nodes: CanvasFlowNode[],
  roots?: Iterable<string>
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const rootIds = roots
    ? [...roots].filter((id) => byId.get(id)?.hidden !== true)
    : nodes
        .filter((node) => node.selected === true && node.hidden !== true)
        .map((node) => node.id)
  if (rootIds.length === 0) return new Set()
  let ids = canvasDescendantIds(nodes, rootIds)
  const frameIds = nodes
    .filter(
      (node) =>
        ids.has(node.id) &&
        node.hidden !== true &&
        canvasNodeKind(node) === 'frame'
    )
    .map((node) => node.id)
  if (frameIds.length > 0) {
    const members = canvasFrameMemberIds(nodes, frameIds)
    for (const member of members) ids.add(member)
    ids = canvasDescendantIds(nodes, ids)
  }
  return ids
}

interface AutoLayoutUnit {
  node: CanvasFlowNode
  rect: CanvasRect
}

/**
 * Resolves an edge endpoint to the top-level unit the layout moves. A grouped
 * node is not ranked on its own: its outermost group travels with it, so an
 * edge attached to any descendant still connects the group's layer to the
 * other endpoint.
 */
function autoLayoutUnitId(
  node: CanvasFlowNode,
  byId: Map<string, CanvasFlowNode>
): string {
  let unit = node
  for (
    let depth = 0;
    unit.parentId && depth < CANVAS_GROUP_MAX_DEPTH;
    depth++
  ) {
    const parent = byId.get(unit.parentId)
    if (!parent) break
    unit = parent
  }
  return unit.id
}

/**
 * Layered auto layout along the existing edges. The graph is a DAG by contract,
 * but an imported board may contain a cycle: nodes in an unresolved cycle keep
 * their existing order and share one layer instead of making layout fail.
 * Groups are single units (their children keep relative coordinates), edges on
 * a group descendant rank the whole group, and frames are excluded from the
 * ranking and re-fitted around their members afterwards.
 */
export function canvasAutoLayout(
  nodes: CanvasFlowNode[],
  edges: { source: string; target: string }[],
  direction: CanvasAutoLayoutDirection,
  scopeIds?: Iterable<string>
): CanvasFlowNode[] | null {
  const scope = scopeIds ? new Set(scopeIds) : null
  const eligible = nodes.filter(
    (node) =>
      node.hidden !== true &&
      !node.parentId &&
      canvasNodeKind(node) !== 'frame' &&
      (!scope || scope.has(node.id))
  )
  if (eligible.length < 2) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const unitById = new Map<string, AutoLayoutUnit>()
  for (const node of eligible) {
    unitById.set(node.id, { node, rect: canvasNodeRect(node, byId) })
  }
  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const id of unitById.keys()) {
    outgoing.set(id, [])
    indegree.set(id, 0)
  }
  for (const edge of edges) {
    const sourceNode = byId.get(edge.source)
    const targetNode = byId.get(edge.target)
    if (!sourceNode || !targetNode) continue
    const source = autoLayoutUnitId(sourceNode, byId)
    const target = autoLayoutUnitId(targetNode, byId)
    if (!unitById.has(source) || !unitById.has(target)) continue
    if (source === target) continue
    outgoing.get(source)?.push(target)
    indegree.set(target, (indegree.get(target) ?? 0) + 1)
  }
  const crossAxis = direction === 'horizontal' ? 'y' : 'x'
  const orderByCross = (a: string, b: string) =>
    axisStart(unitById.get(a)!.rect, crossAxis) -
      axisStart(unitById.get(b)!.rect, crossAxis) || a.localeCompare(b)
  const rank = new Map<string, number>()
  const queued = eligible
    .map((node) => node.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort(orderByCross)
  for (const id of queued) rank.set(id, 0)
  while (queued.length > 0) {
    const id = queued.shift() as string
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1))
      indegree.set(target, (indegree.get(target) ?? 1) - 1)
      if ((indegree.get(target) ?? 0) === 0) {
        queued.push(target)
        queued.sort(orderByCross)
      }
    }
  }
  // A cycle that survived the topological pass shares the layer after the
  // deepest resolved layer, keeping its nodes visible in one row.
  const unresolved = [...unitById.keys()].filter((id) => !rank.has(id))
  if (unresolved.length > 0) {
    const deepest = Math.max(-1, ...rank.values())
    for (const id of unresolved) rank.set(id, deepest + 1)
  }
  const layers = new Map<number, AutoLayoutUnit[]>()
  for (const id of unitById.keys()) {
    const value = rank.get(id) ?? 0
    const layer = layers.get(value) ?? []
    layer.push(unitById.get(id) as AutoLayoutUnit)
    layers.set(value, layer)
  }
  const orderedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0])
  for (const [, layer] of orderedLayers) {
    layer.sort(
      (a, b) =>
        axisStart(a.rect, crossAxis) - axisStart(b.rect, crossAxis) ||
        a.node.id.localeCompare(b.node.id)
    )
  }
  const origin = canvasUnionRect(
    eligible.map((node) => unitById.get(node.id)!.rect)
  )
  if (!origin) return null
  const positions = new Map<string, { x: number; y: number }>()
  if (direction === 'horizontal') {
    let x = origin.x
    for (const [, layer] of orderedLayers) {
      const layerWidth = Math.max(...layer.map((unit) => unit.rect.width))
      let y = origin.y
      for (const unit of layer) {
        positions.set(unit.node.id, {
          x: x + (layerWidth - unit.rect.width) / 2,
          y,
        })
        y += unit.rect.height + CANVAS_AUTO_LAYOUT_GAP_Y
      }
      x += layerWidth + CANVAS_AUTO_LAYOUT_GAP_X
    }
  } else {
    let y = origin.y
    for (const [, layer] of orderedLayers) {
      const layerHeight = Math.max(...layer.map((unit) => unit.rect.height))
      let x = origin.x
      for (const unit of layer) {
        positions.set(unit.node.id, {
          x,
          y: y + (layerHeight - unit.rect.height) / 2,
        })
        x += unit.rect.width + CANVAS_AUTO_LAYOUT_GAP_X
      }
      y += layerHeight + CANVAS_AUTO_LAYOUT_GAP_Y
    }
  }
  let changed = false
  let nextNodes = nodes.map((node) => {
    const position = positions.get(node.id)
    if (!position) return node
    if (
      Math.abs(node.position.x - position.x) < 0.01 &&
      Math.abs(node.position.y - position.y) < 0.01
    ) {
      return node
    }
    changed = true
    return { ...node, position }
  })
  const nextById = new Map(nextNodes.map((node) => [node.id, node]))
  // A frame is never ranked itself, so it follows its members: a visible frame
  // is re-fitted whenever the layout touches one of its members, including a
  // selection-scoped layout that moves a member of a frame outside the scope.
  const frameNodes = nodes.filter(
    (node) => node.hidden !== true && canvasNodeKind(node) === 'frame'
  )
  for (const frame of frameNodes) {
    const members = [...canvasFrameMemberIds(nodes, [frame.id])].filter((id) =>
      positions.has(id)
    )
    if (members.length === 0) continue
    const bounds = canvasUnionRect(
      members.map((id) =>
        canvasNodeRect(nextById.get(id) as CanvasFlowNode, nextById)
      )
    )
    if (!bounds) continue
    const position = {
      x: bounds.x - CANVAS_FRAME_PADDING,
      y: bounds.y - CANVAS_FRAME_PADDING - CANVAS_FRAME_HEADER_HEIGHT,
    }
    const width = Math.max(
      CANVAS_FRAME_MIN_WIDTH,
      bounds.width + CANVAS_FRAME_PADDING * 2
    )
    const height = Math.max(
      CANVAS_FRAME_MIN_HEIGHT,
      bounds.height + CANVAS_FRAME_PADDING * 2 + CANVAS_FRAME_HEADER_HEIGHT
    )
    if (
      Math.abs(frame.position.x - position.x) < 0.01 &&
      Math.abs(frame.position.y - position.y) < 0.01 &&
      Math.abs((frame.width ?? 0) - width) < 0.01 &&
      Math.abs((frame.height ?? 0) - height) < 0.01
    ) {
      continue
    }
    changed = true
    const resized = { ...frame, position, width, height }
    nextNodes = nextNodes.map((node) => (node.id === frame.id ? resized : node))
    nextById.set(frame.id, resized)
  }
  return changed ? nextNodes : null
}
