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
import { expect, test } from 'vitest'

import { CANVAS_HISTORY_LIMIT } from '../../constants'
import type { CanvasFlowNode } from '../../types'
import {
  createCanvasHistory,
  pushCanvasHistory,
  redoCanvasHistory,
  undoCanvasHistory,
} from '../canvas-history'

function snapshot(id: string) {
  return {
    nodes: [
      {
        id,
        type: 'text',
        position: { x: 0, y: 0 },
        data: { kind: 'text', text: id },
      } as CanvasFlowNode,
    ],
    edges: [],
  }
}

test('undo and redo move between recorded snapshots', () => {
  const first = snapshot('n1')
  const second = snapshot('n2')
  const pushed = pushCanvasHistory(createCanvasHistory(first), second)
  expect(pushed.present).toBe(second)

  const undone = undoCanvasHistory(pushed)
  if (!undone) {
    throw new Error('undo should return the previous snapshot')
  }
  expect(undone.snapshot).toBe(first)
  expect(undone.history.present).toBe(first)
  expect(undoCanvasHistory(undone.history)).toBeNull()

  const redone = redoCanvasHistory(undone.history)
  if (!redone) {
    throw new Error('redo should return the undone snapshot')
  }
  expect(redone.snapshot).toBe(second)
  expect(redoCanvasHistory(redone.history)).toBeNull()
})

test('identical snapshots do not create history entries', () => {
  const present = snapshot('n1')
  const history = createCanvasHistory(present)
  expect(pushCanvasHistory(history, { ...present })).toBe(history)
})

test('history keeps at most the configured number of past snapshots', () => {
  let history = createCanvasHistory(snapshot('n0'))
  for (let index = 1; index <= CANVAS_HISTORY_LIMIT + 5; index += 1) {
    history = pushCanvasHistory(history, snapshot(`n${index}`))
  }
  expect(history.past).toHaveLength(CANVAS_HISTORY_LIMIT)
  expect(history.past[0].nodes[0].id).toBe('n5')
})
