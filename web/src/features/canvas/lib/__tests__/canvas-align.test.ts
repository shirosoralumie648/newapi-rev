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
  canvasAlignSelection,
  canvasAlignmentSnap,
  canvasAutoLayout,
  canvasDistributeSelection,
  canvasFrameMemberIds,
  canvasNudgeSelection,
  canvasSelectionExportIds,
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

test('aligns selected cards without changing the cross axis', () => {
  const nodes = [
    node('left', 0, 0, 100, 50, { selected: true }),
    node('right', 300, 100, 50, 50, { selected: true }),
  ]
  const next = canvasAlignSelection(nodes, 'left')
  expect(next?.find((entry) => entry.id === 'left')?.position).toEqual({
    x: 0,
    y: 0,
  })
  expect(next?.find((entry) => entry.id === 'right')?.position).toEqual({
    x: 0,
    y: 100,
  })
})

test('aligns the vertical centers of selected cards', () => {
  const nodes = [
    node('left', 0, 0, 100, 50, { selected: true }),
    node('right', 300, 100, 50, 50, { selected: true }),
  ]
  const next = canvasAlignSelection(nodes, 'middle')
  expect(next?.find((entry) => entry.id === 'left')?.position.y).toBe(50)
  expect(next?.find((entry) => entry.id === 'right')?.position.y).toBe(50)
})

test('alignment needs two selected top-level nodes', () => {
  const nodes = [node('only', 0, 0, 100, 50, { selected: true })]
  expect(canvasAlignSelection(nodes, 'left')).toBeNull()
})

test('lays connected cards out in ranked columns', () => {
  const nodes = [
    node('source', 500, 500, 100, 50),
    node('result', 0, 0, 100, 50),
  ]
  const next = canvasAutoLayout(
    nodes,
    [{ source: 'source', target: 'result' }],
    'horizontal'
  )
  expect(next?.find((entry) => entry.id === 'source')?.position).toEqual({
    x: 0,
    y: 0,
  })
  expect(next?.find((entry) => entry.id === 'result')?.position).toEqual({
    x: 196,
    y: 0,
  })
})

test('lays connected cards out in ranked rows in vertical mode', () => {
  const nodes = [
    node('source', 500, 500, 100, 50),
    node('result', 0, 0, 100, 50),
  ]
  const next = canvasAutoLayout(
    nodes,
    [{ source: 'source', target: 'result' }],
    'vertical'
  )
  expect(next?.find((entry) => entry.id === 'source')?.position).toEqual({
    x: 0,
    y: 0,
  })
  expect(next?.find((entry) => entry.id === 'result')?.position).toEqual({
    x: 0,
    y: 114,
  })
})

test('a frame carries its contained nodes into a selection export', () => {
  const nodes = [
    node('frame', 0, 0, 500, 400, { kind: 'frame', selected: true }),
    node('inside', 40, 40, 100, 50),
    node('outside', 700, 40, 100, 50),
  ]
  const members = canvasFrameMemberIds(nodes, ['frame'])
  expect([...members]).toEqual(['inside'])

  const exported = canvasSelectionExportIds(nodes)
  expect(exported.has('frame')).toBe(true)
  expect(exported.has('inside')).toBe(true)
  expect(exported.has('outside')).toBe(false)
})

test('a selected collapsed group exports its hidden descendants with it', () => {
  const nodes = [
    node('group', 0, 0, 300, 200, { kind: 'group', selected: true }),
    {
      ...node('child', 10, 10, 100, 50, { parentId: 'group' }),
      hidden: true,
    },
  ]
  const exported = canvasSelectionExportIds(nodes)
  expect(exported.has('group')).toBe(true)
  expect(exported.has('child')).toBe(true)
})
