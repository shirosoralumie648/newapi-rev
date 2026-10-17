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
import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { CANVAS_MAX_NODES } from '../../constants'
import type { CanvasServerDocument } from '../../types'
import { useCanvasEditor } from '../use-canvas-editor'

const EMPTY_DOCUMENT: CanvasServerDocument = { nodes: [], edges: [] }

const LINKED_DOCUMENT: CanvasServerDocument = {
  nodes: [
    { id: 'a', type: 'text', position: { x: 0, y: 0 } },
    { id: 'b', type: 'prompt', position: { x: 240, y: 0 } },
  ],
  edges: [{ id: 'a-b', source: 'a', target: 'b' }],
}

test('addNode appends a node and undo/redo restore the graph', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(EMPTY_DOCUMENT, onChange))

  act(() => {
    expect(hook.result.current.addNode('text')).toBe(true)
  })
  expect(hook.result.current.nodes).toHaveLength(1)
  expect(hook.result.current.nodes[0].data.kind).toBe('text')
  expect(hook.result.current.canUndo).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes).toHaveLength(0)
  expect(hook.result.current.canRedo).toBe(true)

  act(() => hook.result.current.redo())
  expect(hook.result.current.nodes).toHaveLength(1)
})

test('addNode refuses to exceed the node limit without notifying autosave', () => {
  const fullDocument: CanvasServerDocument = {
    nodes: Array.from({ length: CANVAS_MAX_NODES }, (_, index) => ({
      id: `node-${index}`,
      type: 'text' as const,
      position: { x: index, y: index },
    })),
    edges: [],
  }
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(fullDocument, onChange))

  let added = true
  act(() => {
    added = hook.result.current.addNode('text')
  })

  expect(added).toBe(false)
  expect(hook.result.current.nodes).toHaveLength(CANVAS_MAX_NODES)
  expect(onChange).not.toHaveBeenCalled()
})

test('deleteNode removes the node together with its incident edges', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() => hook.result.current.deleteNode('a'))

  expect(hook.result.current.nodes.map((node) => node.id)).toEqual(['b'])
  expect(hook.result.current.edges).toHaveLength(0)
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('handleConnect links two nodes and becomes undoable', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor({ ...LINKED_DOCUMENT, edges: [] }, onChange)
  )

  act(() =>
    hook.result.current.handleConnect({
      source: 'a',
      target: 'b',
      sourceHandle: null,
      targetHandle: null,
    })
  )

  expect(hook.result.current.edges).toHaveLength(1)
  expect(hook.result.current.edges[0]).toMatchObject({
    source: 'a',
    target: 'b',
  })
  expect(hook.result.current.canUndo).toBe(true)
})

test('selection changes update state without notifying autosave', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
    ])
  )

  expect(hook.result.current.selectedNode?.id).toBe('a')
  expect(hook.result.current.canUndo).toBe(false)
  expect(onChange).not.toHaveBeenCalled()

  act(() => hook.result.current.clearSelection())
  expect(hook.result.current.selectedNode).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
})

test('finishing a drag records history and notifies autosave', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'position', position: { x: 40, y: 80 }, dragging: false },
    ])
  )

  expect(hook.result.current.nodes[0].position).toEqual({ x: 40, y: 80 })
  expect(hook.result.current.canUndo).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)
})
