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

import { CANVAS_MAX_NODES } from '../../constants'
import type { CanvasFlowEdge, CanvasFlowNode } from '../../types'
import {
  CANVAS_ERRORS,
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
