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

import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
} from '../../types'
import {
  CANVAS_WORKFLOW_BUDGET_TOKEN_MAX,
  canvasWorkflowEstimateSteps,
} from '../canvas-workflow-budget'

function graphNode(
  id: string,
  kind: CanvasNodeData['kind'],
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, ...data } }
}

test('builds one priced step per planned node in run order', () => {
  const nodes = [
    graphNode('p1', 'prompt', { text: 'hello' }),
    graphNode('m1', 'model', { workflow: { model: 'gpt-4o', group: 'vip' } }),
    graphNode('t1', 'task', {
      text: 'a red fox',
      workflow: {
        model: 'gpt-image-1',
        generation: 'image',
        size: '1792x1024',
        quality: 'high',
        imageCount: 3,
      },
    }),
    graphNode('t2', 'task', {
      text: 'a sailing ship',
      workflow: { model: 'kling-v1', generation: 'video' },
    }),
  ]
  const edges: CanvasFlowEdge[] = [{ id: 'e1', source: 'p1', target: 'm1' }]

  const steps = canvasWorkflowEstimateSteps(
    ['m1', 't1', 't2'],
    nodes,
    edges,
    'default'
  )

  expect(
    steps.map((step) => [step.nodeId, step.kind, step.model, step.group])
  ).toEqual([
    ['m1', 'chat', 'gpt-4o', 'vip'],
    ['t1', 'image', 'gpt-image-1', 'default'],
    ['t2', 'video', 'kling-v1', 'default'],
  ])
  expect(steps[0].tokens).toBeGreaterThan(0)
  expect(steps[1]).toMatchObject({
    count: 3,
    size: '1792x1024',
    quality: 'high',
  })
  expect(steps[2]).not.toHaveProperty('count')
})

test('skips steps without a model and keeps the token estimate bounded', () => {
  const nodes = [
    graphNode('m1', 'model', { workflow: {} }),
    graphNode('t1', 'task', {
      text: 'x'.repeat(40000),
      workflow: { model: 'kling-v1', generation: 'video' },
    }),
  ]

  const steps = canvasWorkflowEstimateSteps(['m1', 't1'], nodes, [], 'default')

  expect(steps).toHaveLength(1)
  expect(steps[0]).toMatchObject({ nodeId: 't1', kind: 'video' })
  expect(steps[0].tokens).toBeGreaterThan(0)
  expect(steps[0].tokens).toBeLessThanOrEqual(CANVAS_WORKFLOW_BUDGET_TOKEN_MAX)
})
