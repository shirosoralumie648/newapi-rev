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
import { CANVAS_HISTORY_LIMIT } from '../constants'
import type { CanvasFlowEdge, CanvasFlowNode } from '../types'

export type CanvasSnapshot = {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
}

export type CanvasHistory = {
  past: CanvasSnapshot[]
  present: CanvasSnapshot
  future: CanvasSnapshot[]
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
 * do not create history entries, and the past stack is capped.
 */
export function pushCanvasHistory(
  history: CanvasHistory,
  next: CanvasSnapshot
): CanvasHistory {
  if (canvasSnapshotsEqual(history.present, next)) {
    return history
  }
  const past = [...history.past, history.present]
  if (past.length > CANVAS_HISTORY_LIMIT) {
    past.shift()
  }
  return { past, present: next, future: [] }
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
