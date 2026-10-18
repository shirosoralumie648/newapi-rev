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

import {
  CANVAS_ASSISTANT_CONTEXT_MAX_DEPTH,
  CANVAS_ASSISTANT_CONTEXT_MAX_NODES,
  CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS,
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
  CANVAS_NODE_ADD_OFFSET,
} from '../../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
} from '../../types'
import {
  canvasAssistantContextNodes,
  canvasAssistantInsertPosition,
  canvasAssistantReplyNodeData,
  canvasAssistantSystemPrompt,
  canvasAssistantTaskNodeData,
} from '../canvas-assistant'

function node(
  id: string,
  kind: CanvasNodeKind,
  data: Partial<CanvasNodeData> = {},
  position = { x: 0, y: 0 }
): CanvasFlowNode {
  return { id, type: kind, position, data: { kind, ...data } }
}

function edge(source: string, target: string): CanvasFlowEdge {
  return { id: `${source}->${target}`, source, target }
}

test('collects the anchor and its transitive upstream chain without cycles', () => {
  const nodes = [
    node('a', 'text', { text: 'A' }),
    node('b', 'prompt', { text: 'B' }),
    node('c', 'note', { text: 'C' }),
  ]
  const edges = [edge('b', 'a'), edge('c', 'b'), edge('a', 'b')]

  const context = canvasAssistantContextNodes(nodes[0], nodes, edges)

  expect(context.map((item) => item.id)).toEqual(['a', 'b', 'c'])
})

test('bounds the upstream walk by depth', () => {
  const nodes = Array.from({ length: 12 }, (_, index) =>
    node(`n${index}`, 'text', { text: `t${index}` })
  )
  const edges = nodes
    .slice(1)
    .map((item, index) => edge(item.id, nodes[index].id))

  const context = canvasAssistantContextNodes(nodes[0], nodes, edges)

  expect(context.map((item) => item.id)).toEqual(
    nodes.slice(0, CANVAS_ASSISTANT_CONTEXT_MAX_DEPTH).map((item) => item.id)
  )
})

test('bounds the context by node count', () => {
  const feeders = Array.from(
    { length: CANVAS_ASSISTANT_CONTEXT_MAX_NODES + 5 },
    (_, index) => node(`f${index}`, 'text', { text: `F${index}` })
  )
  const nodes = [node('a', 'text', { text: 'A' }), ...feeders]
  const edges = feeders.map((item) => edge(item.id, 'a'))

  const context = canvasAssistantContextNodes(nodes[0], nodes, edges)

  expect(context).toHaveLength(CANVAS_ASSISTANT_CONTEXT_MAX_NODES)
})

test('falls back to the text-bearing nodes without a selection', () => {
  const nodes = [
    node('a', 'text', { text: 'A' }),
    node('b', 'note'),
    node('c', 'model', { workflow: { output: 'O' } }),
  ]

  const context = canvasAssistantContextNodes(null, nodes, [])

  expect(context.map((item) => item.id)).toEqual(['a', 'c'])
})

test('describes the bounded context in the system prompt', () => {
  const longText = 'x'.repeat(CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS + 50)
  const context = [node('a', 'prompt', { label: 'Story', text: longText })]

  const prompt = canvasAssistantSystemPrompt(context)

  expect(prompt).toContain('[a] Prompt "Story"')
  expect(prompt).toContain('x'.repeat(CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS))
  expect(prompt).not.toContain(
    'x'.repeat(CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS + 1)
  )
  expect(canvasAssistantSystemPrompt([])).toContain('no node carries text')
})

test('places an insert right of the anchor or at the free cascade', () => {
  const anchor = node('a', 'text', { text: 'A' }, { x: 200, y: 40 })

  expect(canvasAssistantInsertPosition(anchor, [anchor])).toEqual({
    x: 200 + CANVAS_LINKED_NODE_OFFSET_X,
    y: 40,
  })

  const free = canvasAssistantInsertPosition(null, [anchor, anchor])
  expect(free).toEqual({
    x: CANVAS_NODE_ADD_BASE + CANVAS_NODE_ADD_OFFSET * 2,
    y: CANVAS_NODE_ADD_BASE + CANVAS_NODE_ADD_OFFSET * 2,
  })
})

test('describes a reply node and a generation step created from a reply', () => {
  expect(canvasAssistantReplyNodeData('reply')).toEqual({ text: 'reply' })
  expect(canvasAssistantTaskNodeData('m1', 'image', 'draw a cat')).toEqual({
    text: 'draw a cat',
    workflow: { model: 'm1', generation: 'image' },
  })
})
