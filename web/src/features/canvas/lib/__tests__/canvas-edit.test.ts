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

import { CANVAS_MAX_NODES, CANVAS_PASTE_OFFSET } from '../../constants'
import type { CanvasFlowEdge, CanvasFlowNode } from '../../types'
import {
  canvasCopySelection,
  canvasExpandRemovedNodes,
  canvasGroupSelection,
  canvasPasteClipboard,
  canvasSelectAll,
  canvasUngroupSelection,
} from '../canvas-edit'

function node(
  id: string,
  kind: CanvasFlowNode['data']['kind'],
  position: { x: number; y: number },
  extra: Partial<CanvasFlowNode> = {}
): CanvasFlowNode {
  return {
    id,
    type: kind,
    position,
    data: { kind },
    ...extra,
  }
}

function select(nodes: CanvasFlowNode[], ids: string[]): CanvasFlowNode[] {
  const selected = new Set(ids)
  return nodes.map((item) =>
    selected.has(item.id) ? { ...item, selected: true } : item
  )
}

test('copy keeps edges between the selected nodes only', () => {
  const nodes = [
    node('a', 'text', { x: 0, y: 0 }),
    node('b', 'model', { x: 1, y: 0 }),
    node('c', 'task', { x: 2, y: 0 }),
  ]
  const edges: CanvasFlowEdge[] = [
    { id: 'a-b', source: 'a', target: 'b' },
    { id: 'b-c', source: 'b', target: 'c' },
  ]

  expect(canvasCopySelection(nodes, edges)).toBeNull()
  const clipboard = canvasCopySelection(select(nodes, ['a', 'b']), edges)
  expect(clipboard?.nodes.map((item) => item.id)).toEqual(['a', 'b'])
  expect(clipboard?.nodes[0].selected).toBe(false)
  expect(clipboard?.edges.map((edge) => edge.id)).toEqual(['a-b'])
})

test('paste re-creates ids, offsets positions and rebuilds internal edges', () => {
  const clipboard = canvasCopySelection(
    select(
      [
        node('a', 'text', { x: 10, y: 20 }),
        node('b', 'model', { x: 40, y: 20 }),
      ],
      ['a', 'b']
    ),
    [{ id: 'a-b', source: 'a', target: 'b' }]
  )
  const pasted = canvasPasteClipboard(clipboard!, {
    nodes: select(
      [
        node('a', 'text', { x: 10, y: 20 }),
        node('b', 'model', { x: 40, y: 20 }),
      ],
      ['a', 'b']
    ),
    edges: [{ id: 'a-b', source: 'a', target: 'b' }],
  })

  expect(pasted?.nodes).toHaveLength(4)
  const copies = pasted!.nodes.slice(2)
  expect(copies.every((item) => item.selected === true)).toBe(true)
  expect(pasted!.nodes.slice(0, 2).every((item) => !item.selected)).toBe(true)
  expect(copies.map((item) => item.position)).toEqual([
    { x: 10 + CANVAS_PASTE_OFFSET, y: 20 + CANVAS_PASTE_OFFSET },
    { x: 40 + CANVAS_PASTE_OFFSET, y: 20 + CANVAS_PASTE_OFFSET },
  ])
  expect(copies[0].id).not.toBe('a')
  expect(pasted!.edges).toHaveLength(2)
  expect(pasted!.edges[1]).toMatchObject({
    source: copies[0].id,
    target: copies[1].id,
  })
})

test('paste is refused as a whole when the canvas has no room', () => {
  const clipboard = canvasCopySelection(
    select([node('a', 'text', { x: 0, y: 0 })], ['a']),
    []
  )
  const full = {
    nodes: Array.from({ length: CANVAS_MAX_NODES }, (_, index) =>
      node(`n${index}`, 'text', { x: index, y: index })
    ),
    edges: [],
  }

  expect(canvasPasteClipboard(clipboard!, full)).toBeNull()
})

test('select all selects every node once', () => {
  const nodes = [
    node('a', 'text', { x: 0, y: 0 }),
    node('b', 'note', { x: 1, y: 0 }),
  ]
  expect(canvasSelectAll(nodes).every((item) => item.selected === true)).toBe(
    true
  )
  const already = canvasSelectAll(nodes)
  expect(canvasSelectAll(already)).toBe(already)
})

test('grouping wraps the selection in a box and stores children relative to it', () => {
  const nodes = select(
    [
      node('a', 'text', { x: 100, y: 100 }),
      node('b', 'model', { x: 300, y: 100 }),
    ],
    ['a', 'b']
  )
  const grouped = canvasGroupSelection(nodes, [])

  expect(grouped).not.toBeNull()
  const group = grouped!.nodes[0]
  expect(group.data.kind).toBe('group')
  expect(group.id).toBe(grouped!.groupId)
  expect(group.selected).toBe(true)
  expect(group.position).toEqual({ x: 100 - 32, y: 100 - 32 })
  expect(group.width).toBe(200 + 256 + 64)
  const children = grouped!.nodes.slice(1)
  expect(children.map((item) => item.parentId)).toEqual([
    grouped!.groupId,
    grouped!.groupId,
  ])
  expect(children.map((item) => item.extent)).toEqual(['parent', 'parent'])
  expect(children.map((item) => item.position)).toEqual([
    { x: 32, y: 32 },
    { x: 232, y: 32 },
  ])
  expect(children[0].data.parentId).toBe(grouped!.groupId)
})

test('grouping refuses an empty selection and a selected group', () => {
  const nodes = [node('a', 'text', { x: 0, y: 0 })]
  expect(canvasGroupSelection(nodes, [])).toBeNull()

  const withGroup = select(
    [node('g', 'group', { x: 0, y: 0 }), node('a', 'text', { x: 0, y: 0 })],
    ['g', 'a']
  )
  expect(canvasGroupSelection(withGroup, [])).toBeNull()
})

test('ungrouping releases children to absolute positions and removes the box', () => {
  const grouped = canvasGroupSelection(
    select(
      [
        node('a', 'text', { x: 100, y: 100 }),
        node('b', 'model', { x: 300, y: 100 }),
      ],
      ['a', 'b']
    ),
    [{ id: 'a-b', source: 'a', target: 'b' }]
  )
  const groupId = grouped!.groupId
  const selectedGroup = grouped!.nodes.map((item) =>
    item.id === groupId || item.parentId === groupId
      ? { ...item, selected: true }
      : item
  )
  const released = canvasUngroupSelection(selectedGroup, grouped!.edges)

  expect(released).not.toBeNull()
  expect(released!.nodes.map((item) => item.id)).toEqual(['a', 'b'])
  expect(released!.nodes.every((item) => item.parentId === undefined)).toBe(
    true
  )
  expect(
    released!.nodes.every((item) => item.data.parentId === undefined)
  ).toBe(true)
  expect(released!.nodes.map((item) => item.position)).toEqual([
    { x: 100, y: 100 },
    { x: 300, y: 100 },
  ])
})

test('ungrouping a single child leaves the group box in place', () => {
  const grouped = canvasGroupSelection(
    select(
      [
        node('a', 'text', { x: 100, y: 100 }),
        node('b', 'model', { x: 300, y: 100 }),
      ],
      ['a', 'b']
    ),
    []
  )
  const groupId = grouped!.groupId
  const oneChild = grouped!.nodes.map((item) =>
    item.id === 'a' ? { ...item, selected: true } : { ...item, selected: false }
  )
  const released = canvasUngroupSelection(oneChild, [])

  expect(released!.nodes.map((item) => item.id)).toEqual([groupId, 'b'])
  const child = released!.nodes.find((item) => item.id === 'b')
  expect(child?.parentId).toBe(groupId)
})

test('ungroup returns null when nothing grouped is selected', () => {
  const nodes = select([node('a', 'text', { x: 0, y: 0 })], ['a'])
  expect(canvasUngroupSelection(nodes, [])).toBeNull()
})

test('removing a group also removes its children', () => {
  const grouped = canvasGroupSelection(
    select(
      [node('a', 'text', { x: 0, y: 0 }), node('b', 'model', { x: 40, y: 0 })],
      ['a', 'b']
    ),
    []
  )
  const expanded = canvasExpandRemovedNodes(
    grouped!.nodes,
    new Set([grouped!.groupId])
  )
  expect([...expanded].sort()).toEqual([grouped!.groupId, 'a', 'b'].sort())
})
