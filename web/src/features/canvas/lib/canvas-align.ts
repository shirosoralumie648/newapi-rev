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
  CANVAS_NODE_ESTIMATED_HEIGHT,
  CANVAS_NODE_ESTIMATED_WIDTH,
} from '../constants'
import type { CanvasFlowNode } from '../types'
import { canvasAbsolutePosition, canvasSelectedTopLevel } from './canvas-edit'

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
