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

import { CANVAS_MAX_NODES, CANVAS_NODE_DATA_MAX_BYTES } from '../../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasServerProject,
} from '../../types'
import {
  CANVAS_ERRORS,
  applyCanvasReferenceStatus,
  fromServerDocument,
  parseCanvasImport,
  serializeCanvasExport,
  toServerDocument,
  validateCanvasDocument,
} from '../canvas-document'

function flowNode(id: string, text: string): CanvasFlowNode {
  return {
    id,
    type: 'prompt',
    position: { x: 12, y: 24 },
    data: { kind: 'prompt', text },
  }
}

function flowEdge(source: string, target: string): CanvasFlowEdge {
  return { id: 'e1', source, target, label: 'then' }
}

test('document round-trips through the server contract', () => {
  const nodes = [flowNode('n1', 'hello'), flowNode('n2', 'world')]
  const edges = [flowEdge('n1', 'n2')]
  const document = toServerDocument(nodes, edges, { x: 1, y: 2, zoom: 1.5 })

  expect(document.nodes[0]).toEqual({
    id: 'n1',
    type: 'prompt',
    position: { x: 12, y: 24 },
    data: { kind: 'prompt', text: 'hello' },
  })
  expect(document.edges[0]).toEqual({
    id: 'e1',
    source: 'n1',
    target: 'n2',
    label: 'then',
  })

  const restored = fromServerDocument(document)
  expect(restored.viewport).toEqual({ x: 1, y: 2, zoom: 1.5 })
  expect(restored.nodes.map((node) => node.data.text)).toEqual([
    'hello',
    'world',
  ])
  expect(restored.edges[0].sourceHandle).toBeUndefined()
  expect(restored.edges[0].label).toBe('then')
})

test('validation rejects dangling edges and over-limit documents', () => {
  expect(
    validateCanvasDocument(
      toServerDocument([flowNode('n1', 'a')], [flowEdge('n1', 'missing')])
    )
  ).toBe(CANVAS_ERRORS.DANGLING_EDGE)
  expect(
    validateCanvasDocument(
      toServerDocument(
        Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, index) =>
          flowNode(`n${index}`, 'x')
        ),
        []
      )
    )
  ).toBe(CANVAS_ERRORS.TOO_MANY_NODES)
  expect(
    validateCanvasDocument(toServerDocument([flowNode('n1', 'a')], []))
  ).toBeNull()
})

test('import only accepts a versioned export and keeps its title', () => {
  expect(() => parseCanvasImport('not json')).toThrow(
    CANVAS_ERRORS.INVALID_FILE
  )
  expect(() => parseCanvasImport('{"version":2,"document":{}}')).toThrow(
    CANVAS_ERRORS.INVALID_FILE
  )
  const exported = serializeCanvasExport(
    'My board',
    toServerDocument([flowNode('n1', 'a')], [])
  )
  const imported = parseCanvasImport(exported)
  expect(imported.title).toBe('My board')
  expect(imported.document.nodes).toHaveLength(1)
})

test('import surfaces an oversized node instead of truncating it', () => {
  const oversized = toServerDocument(
    [flowNode('n1', 'x'.repeat(CANVAS_NODE_DATA_MAX_BYTES + 16))],
    []
  )
  expect(validateCanvasDocument(oversized)).toBe(CANVAS_ERRORS.TOO_LARGE)

  const exported = serializeCanvasExport('Huge', oversized)
  expect(() => parseCanvasImport(exported)).toThrow(CANVAS_ERRORS.TOO_LARGE)
})

test('validation rejects a document that exceeds the byte budget', () => {
  // Each node stays under the per-node data cap, but the document as a whole
  // passes the 1 MiB persistence budget.
  const text = 'y'.repeat(5400)
  const document = toServerDocument(
    Array.from({ length: CANVAS_MAX_NODES }, (_, index) =>
      flowNode(`n${index}`, text)
    ),
    []
  )
  expect(validateCanvasDocument(document)).toBe(CANVAS_ERRORS.TOO_LARGE)
})

function canvasProject(
  project: Partial<CanvasServerProject> & {
    document: CanvasServerProject['document']
  }
): CanvasServerProject {
  return {
    id: 'c1',
    title: 'Board',
    nodeCount: project.document.nodes.length,
    edgeCount: project.document.edges.length,
    documentBytes: 0,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    ...project,
  }
}

test('reference status marks deleted sources and clears stale flags', () => {
  const project = canvasProject({
    unavailableNodeIds: ['n2'],
    document: {
      nodes: [
        {
          id: 'n1',
          type: 'message',
          position: { x: 0, y: 0 },
          data: { kind: 'message', text: 'kept', sourceDeleted: true },
        },
        {
          id: 'n2',
          type: 'attachment',
          position: { x: 0, y: 0 },
          data: {
            kind: 'attachment',
            label: 'cat.png',
            ref: { sessionId: 'pgs_1', attachmentId: 'pgf_1' },
          },
        },
      ],
      edges: [],
    },
  })

  const marked = applyCanvasReferenceStatus(project)

  expect(marked.document.nodes[0].data).not.toHaveProperty('sourceDeleted')
  expect(marked.document.nodes[1].data).toMatchObject({
    sourceDeleted: true,
    label: 'cat.png',
    ref: { sessionId: 'pgs_1', attachmentId: 'pgf_1' },
  })
})

test('reference status leaves a resolvable project untouched', () => {
  const project = canvasProject({
    document: {
      nodes: [
        {
          id: 'n1',
          type: 'message',
          position: { x: 0, y: 0 },
          data: { kind: 'message', text: 'ok' },
        },
      ],
      edges: [],
    },
  })

  expect(applyCanvasReferenceStatus(project)).toBe(project)
})

test('a group round-trips through the server contract in parent-first order', () => {
  const document = toServerDocument(
    [
      {
        id: 'child',
        type: 'text',
        position: { x: 32, y: 32 },
        parentId: 'group',
        extent: 'parent',
        expandParent: true,
        data: { kind: 'text', text: 'inside' },
      },
      {
        id: 'group',
        type: 'group',
        position: { x: 100, y: 100 },
        width: 320,
        height: 200,
        data: { kind: 'group' },
      },
    ],
    []
  )

  // The persisted node data carries the parent, which is the only field the
  // server contract keeps for it.
  expect(document.nodes[0].data).toEqual({
    kind: 'text',
    text: 'inside',
    parentId: 'group',
  })
  expect(document.nodes[1].data).toEqual({ kind: 'group' })

  // A stored document whose order changed (an import, a paste) is read back
  // with the parent first, as xyflow requires.
  const restored = fromServerDocument({
    nodes: [
      document.nodes[0],
      document.nodes[1],
      { id: 'plain', type: 'note', position: { x: 0, y: 0 } },
    ],
    edges: [],
  })
  expect(restored.nodes.map((node) => node.id)).toEqual([
    'group',
    'plain',
    'child',
  ])
  const child = restored.nodes.find((node) => node.id === 'child')
  expect(child?.parentId).toBe('group')
  expect(child?.extent).toBe('parent')
  expect(child?.data.parentId).toBe('group')

  // A parent that is not part of the document is not attached at all, so a
  // hand-edited import cannot produce a dangling child.
  const dangling = fromServerDocument({
    nodes: [
      {
        id: 'lost',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { parentId: 'gone' },
      },
    ],
    edges: [],
  })
  expect(dangling.nodes[0].parentId).toBeUndefined()
})
