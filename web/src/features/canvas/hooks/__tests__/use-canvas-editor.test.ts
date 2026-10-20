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
import { act, fireEvent, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { CANVAS_MAX_NODES } from '../../constants'
import { CANVAS_WORKFLOW_ERRORS } from '../../lib/canvas-workflow'
import type { CanvasFlowNode, CanvasServerDocument } from '../../types'
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

test('handleConnect rejects a connection that would close a cycle', () => {
  const onChange = vi.fn()
  const onRejectedConnection = vi.fn()
  const document: CanvasServerDocument = {
    nodes: [
      { id: 'a', type: 'prompt', position: { x: 0, y: 0 } },
      { id: 'b', type: 'model', position: { x: 1, y: 0 } },
      { id: 'c', type: 'task', position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: 'a-b', source: 'a', target: 'b' },
      { id: 'b-c', source: 'b', target: 'c' },
    ],
  }
  const hook = renderHook(() =>
    useCanvasEditor(document, onChange, { onRejectedConnection })
  )

  act(() =>
    hook.result.current.handleConnect({
      source: 'c',
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
    })
  )

  expect(hook.result.current.edges).toHaveLength(2)
  expect(onRejectedConnection).toHaveBeenCalledWith(
    CANVAS_WORKFLOW_ERRORS.CYCLE
  )
  expect(onChange).not.toHaveBeenCalled()
})

test('addLinkedNode appends a result node wired to its step and becomes undoable', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  let created: string | null = null
  act(() => {
    created = hook.result.current.addLinkedNode(
      'task-result',
      'b',
      { workflow: { status: 'succeeded', sourceNodeId: 'b' } },
      { x: 400, y: 0 }
    )
  })

  expect(created).not.toBeNull()
  expect(hook.result.current.nodes).toHaveLength(3)
  expect(hook.result.current.edges).toContainEqual(
    expect.objectContaining({ source: 'b', target: created })
  )
  const linked = hook.result.current.nodes.find((node) => node.id === created)
  expect(linked?.type).toBe('task-result')
  expect(linked?.data.workflow).toMatchObject({ sourceNodeId: 'b' })
  expect(onChange).toHaveBeenCalledTimes(1)

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes).toHaveLength(2)
  expect(hook.result.current.edges).toHaveLength(1)
})

test('addLinkedNode refuses a full canvas or an unknown source without a commit', () => {
  const unknownOnChange = vi.fn()
  const unknown = renderHook(() =>
    useCanvasEditor(LINKED_DOCUMENT, unknownOnChange)
  )

  let created: string | null = null
  act(() => {
    created = unknown.result.current.addLinkedNode(
      'task-result',
      'missing',
      {},
      { x: 0, y: 0 }
    )
  })
  expect(created).toBeNull()
  expect(unknown.result.current.nodes).toHaveLength(2)
  expect(unknownOnChange).not.toHaveBeenCalled()

  const fullDocument: CanvasServerDocument = {
    nodes: Array.from({ length: CANVAS_MAX_NODES }, (_, index) => ({
      id: `node-${index}`,
      type: 'task' as const,
      position: { x: index, y: index },
    })),
    edges: [],
  }
  const fullOnChange = vi.fn()
  const full = renderHook(() => useCanvasEditor(fullDocument, fullOnChange))

  act(() => {
    created = full.result.current.addLinkedNode(
      'task-result',
      'node-0',
      {},
      { x: 0, y: 0 }
    )
  })
  expect(created).toBeNull()
  expect(full.result.current.nodes).toHaveLength(CANVAS_MAX_NODES)
  expect(fullOnChange).not.toHaveBeenCalled()
})

test('updateNodeData merges a functional update without recording history', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() =>
    hook.result.current.updateNodeData(
      'a',
      (data) => ({ text: `${data.text ?? ''}!` }),
      { record: false }
    )
  )

  expect(hook.result.current.nodes[0].data.text).toBe('!')
  expect(hook.result.current.canUndo).toBe(false)
  expect(onChange).toHaveBeenCalledTimes(1)
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
      {
        id: 'a',
        type: 'position',
        position: { x: 40, y: 80 },
        dragging: false,
      },
    ])
  )

  expect(hook.result.current.nodes[0].position).toEqual({ x: 40, y: 80 })
  expect(hook.result.current.canUndo).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('keyboard shortcuts undo and redo with ctrl, meta, shift+z and y', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(EMPTY_DOCUMENT, onChange))

  act(() => {
    hook.result.current.addNode('text')
  })
  expect(hook.result.current.nodes).toHaveLength(1)

  expect(fireEvent.keyDown(window, { key: 'z', ctrlKey: true })).toBe(false)
  expect(hook.result.current.nodes).toHaveLength(0)
  expect(hook.result.current.canRedo).toBe(true)

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
  expect(hook.result.current.nodes).toHaveLength(1)

  fireEvent.keyDown(window, { key: 'z', metaKey: true })
  expect(hook.result.current.nodes).toHaveLength(0)

  fireEvent.keyDown(window, { key: 'y', metaKey: true })
  expect(hook.result.current.nodes).toHaveLength(1)
})

test('undo shortcuts skip editable fields so native undo keeps working', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(EMPTY_DOCUMENT, onChange))

  act(() => {
    hook.result.current.addNode('text')
  })

  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  expect(fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })).toBe(true)
  expect(hook.result.current.nodes).toHaveLength(1)
  textarea.remove()
})

test('undo shortcuts stay inactive while the editor is disabled', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor(EMPTY_DOCUMENT, onChange, { shortcutsEnabled: false })
  )

  act(() => {
    hook.result.current.addNode('text')
  })

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  expect(hook.result.current.nodes).toHaveLength(1)
})

test('addNodes appends every entry as one undoable step and respects the limit', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(EMPTY_DOCUMENT, onChange))

  act(() => {
    expect(
      hook.result.current.addNodes([
        {
          kind: 'attachment',
          position: { x: 10, y: 20 },
          data: { label: 'cat.png' },
        },
        { kind: 'attachment', position: { x: 310, y: 20 } },
      ])
    ).toBe(2)
  })

  expect(hook.result.current.nodes).toHaveLength(2)
  expect(hook.result.current.nodes[0].data.label).toBe('cat.png')
  expect(onChange).toHaveBeenCalledTimes(1)

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes).toHaveLength(0)

  const fullDocument: CanvasServerDocument = {
    nodes: Array.from({ length: CANVAS_MAX_NODES }, (_, index) => ({
      id: `node-${index}`,
      type: 'text' as const,
      position: { x: index, y: index },
    })),
    edges: [],
  }
  const full = renderHook(() => useCanvasEditor(fullDocument, vi.fn()))
  act(() => {
    expect(
      full.result.current.addNodes([
        { kind: 'text', position: { x: 0, y: 0 } },
        { kind: 'text', position: { x: 1, y: 1 } },
      ])
    ).toBe(0)
  })
  expect(full.result.current.nodes).toHaveLength(CANVAS_MAX_NODES)
})

test('copy and paste shortcuts duplicate the selection with fresh ids', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
      { id: 'b', type: 'select', selected: true },
    ])
  )

  expect(fireEvent.keyDown(window, { key: 'c', ctrlKey: true })).toBe(false)
  expect(hook.result.current.hasClipboard).toBe(true)

  fireEvent.keyDown(window, { key: 'v', ctrlKey: true })
  expect(hook.result.current.nodes).toHaveLength(4)
  const pasted = hook.result.current.nodes.slice(2)
  expect(new Set(hook.result.current.nodes.map((node) => node.id)).size).toBe(4)
  expect(pasted.every((node) => node.selected === true)).toBe(true)
  expect(hook.result.current.edges).toHaveLength(2)
  expect(hook.result.current.canUndo).toBe(true)

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  expect(hook.result.current.nodes).toHaveLength(2)
})

test('copy and paste stay inert without a selection or a clipboard', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  // Without a selection the browser keeps its own copy shortcut.
  expect(fireEvent.keyDown(window, { key: 'c', ctrlKey: true })).toBe(true)
  expect(hook.result.current.hasClipboard).toBe(false)

  // With an empty editor clipboard paste is not intercepted either.
  expect(fireEvent.keyDown(window, { key: 'v', ctrlKey: true })).toBe(true)
  expect(hook.result.current.nodes).toHaveLength(2)
})

test('select all, group and ungroup run through the keyboard shortcuts', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  expect(fireEvent.keyDown(window, { key: 'a', ctrlKey: true })).toBe(false)
  expect(
    hook.result.current.nodes.every((node) => node.selected === true)
  ).toBe(true)

  fireEvent.keyDown(window, { key: 'g', ctrlKey: true })
  const group = hook.result.current.nodes.find(
    (node) => node.data.kind === 'group'
  )
  expect(group).toBeDefined()
  expect(hook.result.current.canUngroup).toBe(true)
  expect(hook.result.current.canGroup).toBe(false)
  expect(hook.result.current.canUndo).toBe(true)

  fireEvent.keyDown(window, { key: 'g', ctrlKey: true, shiftKey: true })
  expect(
    hook.result.current.nodes.some((node) => node.data.kind === 'group')
  ).toBe(false)
  expect(hook.result.current.canGroup).toBe(true)

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  expect(
    hook.result.current.nodes.some((node) => node.data.kind === 'group')
  ).toBe(true)
})

test('deleting a group removes its children and their edges too', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() => {
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
      { id: 'b', type: 'select', selected: true },
    ])
  })
  act(() => hook.result.current.groupSelection())
  const groupId = hook.result.current.nodes.find(
    (node) => node.data.kind === 'group'
  )?.id
  expect(groupId).toBeDefined()
  expect(
    hook.result.current.nodes.filter((node) => node.parentId === groupId)
  ).toHaveLength(2)
  expect(hook.result.current.canGroup).toBe(false)
  expect(hook.result.current.canUngroup).toBe(true)

  act(() =>
    hook.result.current.handleNodesChange([
      { id: groupId ?? '', type: 'remove' },
    ])
  )
  expect(hook.result.current.nodes).toHaveLength(0)
  expect(hook.result.current.edges).toHaveLength(0)
  expect(hook.result.current.canUndo).toBe(true)

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes).toHaveLength(3)
})

test('grouping and pasting refuse an impossible edit without notifying autosave', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  expect(hook.result.current.groupSelection()).toBe(false)
  expect(hook.result.current.pasteSelection()).toBe(false)
  expect(hook.result.current.ungroupSelection()).toBe(false)
  expect(onChange).not.toHaveBeenCalled()
})

test('arrow keys nudge the selection and shift uses the large step', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
    ])
  )

  expect(fireEvent.keyDown(window, { key: 'ArrowRight' })).toBe(false)
  expect(hook.result.current.nodes[0].position).toEqual({ x: 1, y: 0 })

  expect(fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true })).toBe(
    false
  )
  expect(hook.result.current.nodes[0].position).toEqual({ x: 1, y: 10 })
  expect(onChange).toHaveBeenCalledTimes(2)

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes[0].position).toEqual({ x: 0, y: 0 })
})

test('delete removes selected nodes and edges while editable fields keep the key', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor(
      {
        ...LINKED_DOCUMENT,
        nodes: [
          ...LINKED_DOCUMENT.nodes,
          { id: 'c', type: 'text', position: { x: 480, y: 0 } },
        ],
        edges: [
          ...LINKED_DOCUMENT.edges,
          { id: 'b-c', source: 'b', target: 'c' },
        ],
      },
      onChange
    )
  )

  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'b', type: 'select', selected: true },
    ])
  )
  expect(fireEvent.keyDown(window, { key: 'Delete' })).toBe(false)
  expect(hook.result.current.nodes.map((node) => node.id)).toEqual(['a', 'c'])
  expect(hook.result.current.edges).toHaveLength(0)

  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  expect(fireEvent.keyDown(textarea, { key: 'Backspace' })).toBe(true)
  textarea.remove()
})

test('delete removes only a selected edge and keeps its nodes', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() =>
    hook.result.current.handleEdgesChange([
      { id: 'a-b', type: 'select', selected: true },
    ])
  )
  expect(fireEvent.keyDown(window, { key: 'Delete' })).toBe(false)
  expect(hook.result.current.nodes.map((node) => node.id)).toEqual(['a', 'b'])
  expect(hook.result.current.edges).toHaveLength(0)
})

test('reconnect replaces the edge endpoint and rejects a cycle', () => {
  const onChange = vi.fn()
  const onRejectedConnection = vi.fn()
  const document: CanvasServerDocument = {
    nodes: [
      { id: 'a', type: 'prompt', position: { x: 0, y: 0 } },
      { id: 'b', type: 'model', position: { x: 1, y: 0 } },
      { id: 'c', type: 'task', position: { x: 2, y: 0 } },
    ],
    edges: [
      { id: 'a-b', source: 'a', target: 'b' },
      { id: 'b-c', source: 'b', target: 'c' },
    ],
  }
  const hook = renderHook(() =>
    useCanvasEditor(document, onChange, { onRejectedConnection })
  )

  const oldEdge = hook.result.current.edges[0]
  act(() =>
    hook.result.current.handleReconnect(oldEdge, {
      source: 'a',
      target: 'c',
      sourceHandle: null,
      targetHandle: null,
    })
  )
  expect(
    hook.result.current.edges.find((edge) => edge.id === oldEdge.id)
  ).toMatchObject({
    source: 'a',
    target: 'c',
  })

  const cycleEdge = hook.result.current.edges.find(
    (edge) => edge.id === oldEdge.id
  ) as (typeof hook.result.current.edges)[number]
  act(() =>
    hook.result.current.handleReconnect(cycleEdge, {
      source: 'c',
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
    })
  )
  expect(onRejectedConnection).toHaveBeenCalledWith(
    CANVAS_WORKFLOW_ERRORS.CYCLE
  )
  expect(
    hook.result.current.edges.find((edge) => edge.id === oldEdge.id)
  ).toMatchObject({
    source: 'a',
    target: 'c',
  })
})

test('distributeSelection spaces three selected nodes evenly', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor(
      {
        nodes: [
          { id: 'a', type: 'text', position: { x: 0, y: 0 } },
          { id: 'b', type: 'text', position: { x: 200, y: 0 } },
          { id: 'c', type: 'text', position: { x: 500, y: 0 } },
        ],
        edges: [],
      },
      onChange
    )
  )

  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
      { id: 'b', type: 'select', selected: true },
      { id: 'c', type: 'select', selected: true },
    ])
  )
  expect(hook.result.current.canDistribute).toBe(true)
  act(() => {
    expect(hook.result.current.distributeSelection('horizontal')).toBe(true)
  })
  expect(
    hook.result.current.nodes.find((node) => node.id === 'b')?.position.x
  ).toBe(250)
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('frame and sticky nodes are added, edited and deleted as undoable steps', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(EMPTY_DOCUMENT, onChange))

  act(() => {
    expect(hook.result.current.addNode('frame')).toBe(true)
    expect(hook.result.current.addNode('sticky')).toBe(true)
  })
  const frame = hook.result.current.nodes.find(
    (node) => node.data.kind === 'frame'
  )
  const sticky = hook.result.current.nodes.find(
    (node) => node.data.kind === 'sticky'
  )
  expect(frame?.width ?? 0).toBeGreaterThan(0)
  expect(sticky?.height ?? 0).toBeGreaterThan(0)
  expect(onChange).toHaveBeenCalledTimes(2)

  act(() =>
    hook.result.current.updateNodeData(
      sticky?.id ?? '',
      { text: 'Draft' },
      { mergeKey: `text:${sticky?.id}` }
    )
  )
  expect(
    hook.result.current.nodes.find((node) => node.id === sticky?.id)?.data.text
  ).toBe('Draft')
  expect(onChange).toHaveBeenCalledTimes(3)

  act(() => hook.result.current.deleteNode(frame?.id ?? ''))
  expect(hook.result.current.nodes.map((node) => node.id)).toEqual([sticky?.id])

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes.map((node) => node.id)).toEqual([
    frame?.id,
    sticky?.id,
  ])

  act(() => hook.result.current.undo())
  expect(
    hook.result.current.nodes.find((node) => node.id === sticky?.id)?.data.text
  ).toBeUndefined()

  act(() => hook.result.current.redo())
  expect(
    hook.result.current.nodes.find((node) => node.id === sticky?.id)?.data.text
  ).toBe('Draft')

  act(() => hook.result.current.redo())
  expect(hook.result.current.nodes.map((node) => node.id)).toEqual([sticky?.id])
})

test('align and auto layout move positions without touching edges or data', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor(
      {
        nodes: [
          {
            id: 'a',
            type: 'prompt',
            position: { x: 0, y: 0 },
            data: { kind: 'prompt', text: 'hero' },
          },
          {
            id: 'b',
            type: 'model',
            position: { x: 200, y: 40 },
            data: { kind: 'model', workflow: { model: 'gpt-4o' } },
          },
          {
            id: 'c',
            type: 'task-result',
            position: { x: 500, y: 90 },
            data: { kind: 'task-result' },
          },
        ],
        edges: [
          { id: 'a-b', source: 'a', target: 'b' },
          { id: 'b-c', source: 'b', target: 'c' },
        ],
      },
      onChange
    )
  )
  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
      { id: 'b', type: 'select', selected: true },
      { id: 'c', type: 'select', selected: true },
    ])
  )
  const dataBefore = new Map(
    hook.result.current.nodes.map((node) => [node.id, node.data])
  )
  const edgesBefore = hook.result.current.edges

  act(() => expect(hook.result.current.alignSelection('left')).toBe(true))
  expect(hook.result.current.nodes.map((node) => node.position.x)).toEqual([
    0, 0, 0,
  ])
  expect(hook.result.current.edges).toEqual(edgesBefore)
  for (const node of hook.result.current.nodes) {
    expect(node.data).toBe(dataBefore.get(node.id))
  }

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes.map((node) => node.position.x)).toEqual([
    0, 200, 500,
  ])
  act(() => hook.result.current.redo())
  expect(hook.result.current.nodes.map((node) => node.position.x)).toEqual([
    0, 0, 0,
  ])

  act(() => expect(hook.result.current.autoLayout('horizontal')).toBe(true))
  expect(
    hook.result.current.nodes.find((node) => node.id === 'b')?.position
  ).toEqual({ x: 352, y: 0 })
  expect(hook.result.current.edges).toEqual(edgesBefore)
  for (const node of hook.result.current.nodes) {
    expect(node.data).toBe(dataBefore.get(node.id))
  }

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes.map((node) => node.position.x)).toEqual([
    0, 0, 0,
  ])
})

test('collapse selection folds a group and expand restores it undoably', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor(
      {
        nodes: [
          {
            id: 'a',
            type: 'prompt',
            position: { x: 0, y: 0 },
            data: { kind: 'prompt', text: 'hero' },
          },
          {
            id: 'b',
            type: 'model',
            position: { x: 320, y: 0 },
            data: { kind: 'model' },
          },
        ],
        edges: [{ id: 'a-b', source: 'a', target: 'b' }],
      },
      onChange
    )
  )
  act(() =>
    hook.result.current.handleNodesChange([
      { id: 'a', type: 'select', selected: true },
      { id: 'b', type: 'select', selected: true },
    ])
  )

  act(() => expect(hook.result.current.collapseSelection()).toBe(true))
  const group = hook.result.current.nodes.find(
    (node) => node.data.kind === 'group'
  )
  expect(group?.data.collapsed).toBe(true)
  expect(
    hook.result.current.nodes.find((node) => node.id === 'a')?.hidden
  ).toBe(true)
  expect(hook.result.current.edges[0]?.hidden).toBe(true)
  expect(onChange).toHaveBeenCalled()

  act(() => hook.result.current.undo())
  expect(
    hook.result.current.nodes.some((node) => node.data.kind === 'group')
  ).toBe(false)
  expect(
    hook.result.current.nodes.find((node) => node.id === 'a')?.hidden
  ).not.toBe(true)
  expect(hook.result.current.edges[0]?.hidden).not.toBe(true)

  act(() => hook.result.current.redo())
  expect(
    hook.result.current.nodes.find((node) => node.data.kind === 'group')?.data
      .collapsed
  ).toBe(true)

  act(() => expect(hook.result.current.expandSelection()).toBe(true))
  expect(
    hook.result.current.nodes.find((node) => node.data.kind === 'group')?.data
      .collapsed
  ).toBeUndefined()
  expect(
    hook.result.current.nodes.find((node) => node.id === 'a')?.hidden
  ).toBe(false)

  act(() => hook.result.current.undo())
  expect(
    hook.result.current.nodes.find((node) => node.data.kind === 'group')?.data
      .collapsed
  ).toBe(true)
})

test('dragging snaps to a nearby edge and records one history entry', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))
  const first = hook.result.current.nodes[0]
  const dragged = {
    ...hook.result.current.nodes[1],
    position: { x: 258, y: 0 },
  } as CanvasFlowNode
  const event = new MouseEvent('mousedown')

  act(() => hook.result.current.handleNodeDragStart(event, dragged, [dragged]))
  act(() => hook.result.current.handleNodeDrag(event, dragged, [dragged]))

  expect(
    hook.result.current.nodes.find((node) => node.id === 'b')?.position.x
  ).toBe(256)
  expect(hook.result.current.alignmentGuides.length).toBeGreaterThan(0)
  expect(onChange).not.toHaveBeenCalled()

  act(() => hook.result.current.handleNodeDragStop(event, dragged, [dragged]))
  expect(hook.result.current.alignmentGuides).toEqual([])
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(hook.result.current.canUndo).toBe(true)
  expect(first.position).toEqual({ x: 0, y: 0 })
})

test('addGraph adds nodes and their links in one undoable step', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(EMPTY_DOCUMENT, onChange))

  let created: string[] | null = null
  act(() => {
    created = hook.result.current.addGraph(
      [
        {
          kind: 'task',
          position: { x: 0, y: 0 },
          data: { kind: 'task', text: 'a red fox' },
        },
        {
          kind: 'attachment',
          position: { x: -300, y: 0 },
          data: {
            kind: 'attachment',
            ref: { sessionId: 'pgs_1', attachmentId: 'a1' },
          },
        },
      ],
      [
        {
          source: 1,
          target: 0,
          sourceHandle: 'right',
          targetHandle: 'left',
          label: 'reference',
        },
      ]
    )
  })

  expect(created).toHaveLength(2)
  expect(hook.result.current.nodes).toHaveLength(2)
  expect(hook.result.current.edges).toHaveLength(1)
  expect(hook.result.current.edges[0].source).toBe(
    hook.result.current.nodes[1].id
  )
  expect(hook.result.current.edges[0].target).toBe(
    hook.result.current.nodes[0].id
  )
  expect(hook.result.current.edges[0]).toMatchObject({
    sourceHandle: 'right',
    targetHandle: 'left',
    label: 'reference',
  })

  act(() => hook.result.current.undo())
  expect(hook.result.current.nodes).toHaveLength(0)
  expect(hook.result.current.edges).toHaveLength(0)
})

test('addGraph refuses a graph that does not fit the canvas budget', () => {
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

  let created: string[] | null = ['pending']
  act(() => {
    created = hook.result.current.addGraph(
      [
        {
          kind: 'task',
          position: { x: 0, y: 0 },
          data: { kind: 'task', text: 'a red fox' },
        },
      ],
      []
    )
  })

  expect(created).toBeNull()
  expect(hook.result.current.nodes).toHaveLength(CANVAS_MAX_NODES)
  expect(onChange).not.toHaveBeenCalled()
})

test('setWorkflowPreferredResult switches a batch preference in one history entry', () => {
  const document: CanvasServerDocument = {
    nodes: [
      {
        id: 't1',
        type: 'task',
        position: { x: 0, y: 0 },
        data: {
          workflow: {
            model: 'gpt-image-1',
            generation: 'image',
            preferredResultNodeId: 'r1',
          },
        },
      },
      {
        id: 'r1',
        type: 'task-result',
        position: { x: 240, y: 0 },
        data: { workflow: { sourceNodeId: 't1', preferred: true } },
      },
      {
        id: 'r2',
        type: 'task-result',
        position: { x: 240, y: 220 },
        data: { workflow: { sourceNodeId: 't1', preferred: false } },
      },
    ],
    edges: [],
  }
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(document, onChange))

  act(() => hook.result.current.setWorkflowPreferredResult('r2'))

  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
      ?.preferredResultNodeId
  ).toBe('r2')
  expect(
    hook.result.current.nodes.find((node) => node.id === 'r1')?.data.workflow
      ?.preferred
  ).toBe(false)
  expect(
    hook.result.current.nodes.find((node) => node.id === 'r2')?.data.workflow
      ?.preferred
  ).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)

  act(() => hook.result.current.undo())
  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
      ?.preferredResultNodeId
  ).toBe('r1')
  expect(
    hook.result.current.nodes.find((node) => node.id === 'r1')?.data.workflow
      ?.preferred
  ).toBe(true)
})

test('affixNodes moves and marks the bloodline in one undoable step', () => {
  const onChange = vi.fn()
  const hook = renderHook(() =>
    useCanvasEditor(
      {
        nodes: [
          {
            id: 't1',
            type: 'task',
            position: { x: 0, y: 0 },
            data: { workflow: { generation: 'image' } },
          },
          {
            id: 'r1',
            type: 'task-result',
            position: { x: 340, y: 0 },
            data: { workflow: { sourceNodeId: 't1' } },
          },
          {
            id: 'other',
            type: 'task-result',
            position: { x: 0, y: 500 },
          },
        ],
        edges: [],
      },
      onChange
    )
  )

  act(() => {
    expect(
      hook.result.current.affixNodes([
        { id: 't1', position: { x: 0, y: 768 }, data: { affixed: true } },
        { id: 'r1', position: { x: 340, y: 768 }, data: { affixed: true } },
      ])
    ).toBe(true)
  })

  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')
  ).toMatchObject({ position: { x: 0, y: 768 }, data: { affixed: true } })
  expect(
    hook.result.current.nodes.find((node) => node.id === 'r1')
  ).toMatchObject({ position: { x: 340, y: 768 }, data: { affixed: true } })
  expect(
    hook.result.current.nodes.find((node) => node.id === 'other')?.position
  ).toEqual({ x: 0, y: 500 })
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(hook.result.current.canUndo).toBe(true)

  act(() => hook.result.current.undo())
  const restored = hook.result.current.nodes.find((node) => node.id === 't1')
  expect(restored).toMatchObject({
    position: { x: 0, y: 0 },
    data: { kind: 'task', workflow: { generation: 'image' } },
  })
  expect(restored?.data.affixed).toBeUndefined()
  expect(
    hook.result.current.nodes.find((node) => node.id === 'r1')?.position
  ).toEqual({ x: 340, y: 0 })

  act(() => {
    expect(
      hook.result.current.affixNodes([
        { id: 'missing', position: { x: 0, y: 0 }, data: { affixed: true } },
      ])
    ).toBe(false)
  })
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('selectNode marks exactly one node and stays out of the undo history', () => {
  const onChange = vi.fn()
  const hook = renderHook(() => useCanvasEditor(LINKED_DOCUMENT, onChange))

  act(() => hook.result.current.selectNode('a'))
  expect(hook.result.current.selectedNode?.id).toBe('a')
  expect(hook.result.current.canUndo).toBe(false)

  act(() => hook.result.current.selectNode('b'))
  expect(hook.result.current.selectedNode?.id).toBe('b')

  act(() => hook.result.current.selectNode(null))
  expect(hook.result.current.selectedNode).toBeNull()
})
