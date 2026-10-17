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
  CANVAS_WORKFLOW_ERROR_MAX_CHARS,
  CANVAS_WORKFLOW_INPUT_MAX_CHARS,
} from '../../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
} from '../../types'
import {
  boundCanvasWorkflowError,
  CANVAS_WORKFLOW_ERRORS,
  canvasWorkflowNodeText,
  canvasWorkflowOutputTargets,
  hasCanvasWorkflowInput,
  orderCanvasWorkflow,
  resolveCanvasWorkflowInput,
  validateCanvasWorkflow,
  wouldCreateCanvasWorkflowCycle,
} from '../canvas-workflow'

function flowNode(
  id: string,
  kind: CanvasNodeData['kind'],
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, ...data } }
}

function flowEdge(source: string, target: string): CanvasFlowEdge {
  return { id: `${source}-${target}`, source, target }
}

function modelNode(id: string, model?: string): CanvasFlowNode {
  return flowNode(id, 'model', {
    workflow: model === undefined ? {} : { model },
  })
}

test('orders the steps by dependency and refuses a cyclic graph', () => {
  const nodes = [
    flowNode('p1', 'prompt', { text: 'hello' }),
    modelNode('m1', 'gpt-4o'),
    modelNode('m2', 'gpt-4o-mini'),
    flowNode('r1', 'task-result'),
  ]
  const edges = [
    flowEdge('p1', 'm1'),
    flowEdge('m1', 'm2'),
    flowEdge('m2', 'r1'),
  ]

  expect(orderCanvasWorkflow(nodes, edges)).toEqual({ steps: ['m1', 'm2'] })
  expect(
    orderCanvasWorkflow(nodes, [flowEdge('m1', 'm2'), flowEdge('m2', 'm1')])
  ).toEqual({ error: CANVAS_WORKFLOW_ERRORS.CYCLE })
})

test('refuses a connection that closes a loop and allows a forward link', () => {
  const edges = [flowEdge('a', 'b'), flowEdge('b', 'c')]

  expect(wouldCreateCanvasWorkflowCycle(edges, 'c', 'a')).toBe(true)
  expect(wouldCreateCanvasWorkflowCycle(edges, 'c', 'd')).toBe(false)
  expect(wouldCreateCanvasWorkflowCycle(edges, 'a', 'a')).toBe(true)
})

test('validation reports missing steps, model and upstream input', () => {
  const prompt = flowNode('p1', 'prompt', { text: 'hello' })

  expect(validateCanvasWorkflow([prompt], [])).toBe(
    CANVAS_WORKFLOW_ERRORS.NO_STEPS
  )
  expect(
    validateCanvasWorkflow([prompt, modelNode('m1')], [flowEdge('p1', 'm1')])
  ).toBe(CANVAS_WORKFLOW_ERRORS.MODEL_REQUIRED)
  expect(validateCanvasWorkflow([prompt, modelNode('m1', 'gpt-4o')], [])).toBe(
    CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED
  )
  expect(
    validateCanvasWorkflow(
      [prompt, modelNode('m1', 'gpt-4o')],
      [flowEdge('p1', 'm1')]
    )
  ).toBeNull()
})

test('hasCanvasWorkflowInput accepts own text or a connection', () => {
  const bare = modelNode('m1', 'gpt-4o')

  expect(hasCanvasWorkflowInput(bare, [])).toBe(false)
  expect(
    hasCanvasWorkflowInput(flowNode('m2', 'model', { text: 'do it' }), [])
  ).toBe(true)
  expect(hasCanvasWorkflowInput(bare, [flowEdge('p1', 'm1')])).toBe(true)
})

test('resolves a step input from its own text and upstream outputs', () => {
  const prompt = flowNode('p1', 'prompt', { text: 'upstream' })
  const step = flowNode('m1', 'model', {
    text: 'own',
    workflow: { model: 'gpt-4o' },
  })
  const edges = [flowEdge('p1', 'm1')]
  const outputs = new Map<string, string>()

  expect(resolveCanvasWorkflowInput(step, [prompt, step], edges, outputs)).toBe(
    'own\n\nupstream'
  )

  outputs.set('p1', 'fresh')
  expect(resolveCanvasWorkflowInput(step, [prompt, step], edges, outputs)).toBe(
    'own\n\nfresh'
  )
})

test('falls back to the stored output of an upstream step and bounds the text', () => {
  const upstream = flowNode('m0', 'model', {
    workflow: { model: 'gpt-4o', output: 'stored output' },
  })
  const step = flowNode('m1', 'model', { workflow: { model: 'gpt-4o' } })

  expect(
    resolveCanvasWorkflowInput(
      step,
      [upstream, step],
      [flowEdge('m0', 'm1')],
      new Map()
    )
  ).toBe('stored output')

  const long = flowNode('p1', 'prompt', { text: 'x'.repeat(9000) })
  const resolved = resolveCanvasWorkflowInput(
    flowNode('m2', 'model', { workflow: { model: 'gpt-4o' } }),
    [long],
    [flowEdge('p1', 'm2')],
    new Map()
  )
  expect(resolved).toHaveLength(CANVAS_WORKFLOW_INPUT_MAX_CHARS)
})

test('canvasWorkflowNodeText prefers authored text over saved output', () => {
  expect(
    canvasWorkflowNodeText({
      kind: 'model',
      text: 'typed',
      workflow: { model: 'gpt-4o', output: 'previous' },
    })
  ).toBe('typed')
  expect(
    canvasWorkflowNodeText({
      kind: 'model',
      workflow: { model: 'gpt-4o', output: 'previous' },
    })
  ).toBe('previous')
})

test('collects only the downstream task-result nodes of a generation step', () => {
  const nodes = [
    flowNode('t1', 'task', { workflow: { model: 'gpt-image-1' } }),
    flowNode('r1', 'task-result'),
    flowNode('r2', 'task-result'),
    flowNode('n1', 'note', { text: 'notes' }),
  ]
  const edges = [
    flowEdge('t1', 'n1'),
    flowEdge('t1', 'r1'),
    flowEdge('t1', 'r2'),
    flowEdge('t1', 'r1'),
  ]

  expect(canvasWorkflowOutputTargets('t1', nodes, edges)).toEqual(['r1', 'r2'])
})

test('bounds a failure summary before it is stored on a node', () => {
  const bounded = boundCanvasWorkflowError('e'.repeat(2000))

  expect(bounded).toHaveLength(CANVAS_WORKFLOW_ERROR_MAX_CHARS)
  expect(boundCanvasWorkflowError('short')).toBe('short')
})
