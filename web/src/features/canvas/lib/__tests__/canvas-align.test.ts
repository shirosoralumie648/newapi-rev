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

import type { CanvasFlowNode, CanvasNodeKind } from '../../types'
import {
  canvasAlignmentSnap,
  canvasDistributeSelection,
  canvasNudgeSelection,
} from '../canvas-align'

function node(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 50,
  options: { kind?: CanvasNodeKind; parentId?: string; selected?: boolean } = {}
): CanvasFlowNode {
  return {
    id,
    type: options.kind ?? 'text',
    position: { x, y },
    measured: { width, height },
    selected: options.selected ?? false,
    parentId: options.parentId,
    data: { kind: options.kind ?? 'text' },
  } as CanvasFlowNode
}

test('snaps a moving card to the left edge of another card', () => {
  const snap = canvasAlignmentSnap({ x: 103, y: 200, width: 100, height: 50 }, [
    { x: 100, y: 0, width: 100, height: 50 },
  ])
  expect(snap.dx).toBe(-3)
  expect(snap.dy).toBe(0)
  expect(snap.guides).toContainEqual({
    axis: 'x',
    kind: 'align',
    position: 100,
    start: 0,
    end: 250,
  })
})

test('snaps centers when the edges are not close enough', () => {
  const snap = canvasAlignmentSnap({ x: 48, y: 200, width: 100, height: 50 }, [
    { x: 0, y: 0, width: 200, height: 50 },
  ])
  expect(snap.dx).toBe(2)
  expect(snap.guides.some((guide) => guide.position === 100)).toBe(true)
})

test('snaps an equal gap to the right of a reference pair', () => {
  const snap = canvasAlignmentSnap({ x: 805, y: 0, width: 80, height: 50 }, [
    { x: 0, y: 0, width: 100, height: 50 },
    { x: 400, y: 0, width: 100, height: 50 },
  ])
  expect(snap.dx).toBe(-5)
  expect(snap.guides.filter((guide) => guide.kind === 'gap')).toHaveLength(2)
})

test('nudges a selected group without touching its child coordinates', () => {
  const nodes = [
    node('group', 100, 100, 300, 200, {
      kind: 'group',
      selected: true,
    }),
    node('child', 10, 10, 100, 50, { parentId: 'group', selected: true }),
    node('other', 500, 500),
  ]
  const next = canvasNudgeSelection(nodes, 5, -10)
  expect(next?.find((entry) => entry.id === 'group')?.position).toEqual({
    x: 105,
    y: 90,
  })
  expect(next?.find((entry) => entry.id === 'child')?.position).toEqual({
    x: 10,
    y: 10,
  })
  expect(next?.find((entry) => entry.id === 'other')).toBe(nodes[2])
})

test('distributes the interior selected cards with equal gaps', () => {
  const nodes = [
    node('left', 0, 0, 100, 50, { selected: true }),
    node('middle', 200, 0, 50, 50, { selected: true }),
    node('right', 500, 0, 100, 50, { selected: true }),
  ]
  const next = canvasDistributeSelection(nodes, 'horizontal')
  expect(next?.find((entry) => entry.id === 'left')?.position.x).toBe(0)
  expect(next?.find((entry) => entry.id === 'middle')?.position.x).toBe(275)
  expect(next?.find((entry) => entry.id === 'right')?.position.x).toBe(500)
})

test('distribution needs three top-level selected nodes', () => {
  const nodes = [
    node('left', 0, 0, 100, 50, { selected: true }),
    node('right', 500, 0, 100, 50, { selected: true }),
  ]
  expect(canvasDistributeSelection(nodes, 'horizontal')).toBeNull()
})
