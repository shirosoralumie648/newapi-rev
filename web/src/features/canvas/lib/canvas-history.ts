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
import { CANVAS_HISTORY_LIMIT, CANVAS_HISTORY_MERGE_MS } from '../constants'
import type { CanvasFlowEdge, CanvasFlowNode } from '../types'

export type CanvasSnapshot = {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
}

/** A merge window lets keystrokes or a nudge burst share one undo entry. */
export type CanvasHistoryMerge = {
  key: string
  at?: number
  window?: number
}

export type CanvasHistory = {
  past: CanvasSnapshot[]
  present: CanvasSnapshot
  future: CanvasSnapshot[]
  /** The entry the latest present value was merged into, if any. */
  merge?: { key: string; at: number }
}

export function createCanvasHistory(present: CanvasSnapshot): CanvasHistory {
  return { past: [], present, future: [] }
}

export function canvasSnapshotsEqual(
  a: CanvasSnapshot,
  b: CanvasSnapshot
): boolean {
  return a.nodes === b.nodes && a.edges === b.edges
}

/**
 * Records a new present value. Consecutive identical states (same references)
 * do not create history entries, and the past stack is capped. A merge key
 * replaces the present value of a recent entry instead of appending another
 * one, so typing a sentence or holding an arrow key is undone in one step.
 */
export function pushCanvasHistory(
  history: CanvasHistory,
  next: CanvasSnapshot,
  merge?: CanvasHistoryMerge
): CanvasHistory {
  if (canvasSnapshotsEqual(history.present, next)) {
    return history
  }
  const at = merge?.at ?? Date.now()
  const window = merge?.window ?? CANVAS_HISTORY_MERGE_MS
  if (
    merge &&
    history.merge?.key === merge.key &&
    history.past.length > 0 &&
    at - history.merge.at >= 0 &&
    at - history.merge.at <= window
  ) {
    return {
      ...history,
      present: next,
      future: [],
      merge: { key: merge.key, at },
    }
  }
  const past = [...history.past, history.present]
  if (past.length > CANVAS_HISTORY_LIMIT) {
    past.shift()
  }
  return {
    past,
    present: next,
    future: [],
    ...(merge ? { merge: { key: merge.key, at } } : {}),
  }
}

export function undoCanvasHistory(history: CanvasHistory): {
  history: CanvasHistory
  snapshot: CanvasSnapshot
} | null {
  const previous = history.past.at(-1)
  if (!previous) {
    return null
  }
  return {
    snapshot: previous,
    history: {
      past: history.past.slice(0, -1),
      present: previous,
      future: [history.present, ...history.future],
    },
  }
}

export function redoCanvasHistory(history: CanvasHistory): {
  history: CanvasHistory
  snapshot: CanvasSnapshot
} | null {
  const next = history.future[0]
  if (!next) {
    return null
  }
  return {
    snapshot: next,
    history: {
      past: [...history.past, history.present],
      present: next,
      future: history.future.slice(1),
    },
  }
}
