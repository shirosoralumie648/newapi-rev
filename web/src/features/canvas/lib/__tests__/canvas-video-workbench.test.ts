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

import { CANVAS_NODE_ADD_BASE } from '../../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
} from '../../types'
import {
  canvasVideoWorkbenchDefaultStep,
  canvasVideoWorkbenchSource,
  canvasVideoWorkbenchStep,
  canvasVideoWorkbenchVariantLabel,
  canvasVideoWorkbenchVariants,
} from '../canvas-video-workbench'

function flowNode(
  id: string,
  kind: CanvasNodeData['kind'],
  x: number,
  y: number,
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return {
    id,
    type: kind,
    position: { x, y },
    data: { kind, ...data },
  }
}

function flowEdge(source: string, target: string): CanvasFlowEdge {
  return { id: `${source}-${target}`, source, target }
}

function videoResult(
  id: string,
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return flowNode(id, 'video', 340, 0, {
    ref: { taskId: `task-${id}`, taskArtifactKey: `artifact-${id}` },
    workflow: { sourceNodeId: 'step' },
    ...data,
  })
}

test('focuses the top-left video step and ignores image steps', () => {
  const nodes = [
    flowNode('image', 'task', 0, -200, {
      workflow: { generation: 'image' },
    }),
    flowNode('lower', 'task', 0, 120, {
      workflow: { generation: 'video' },
    }),
    flowNode('upper', 'task', 40, 20, {
      workflow: { generation: 'video' },
    }),
  ]

  expect(canvasVideoWorkbenchStep(nodes)?.id).toBe('upper')
  expect(
    canvasVideoWorkbenchStep([
      flowNode('image-only', 'task', 0, 0, {
        workflow: { generation: 'image' },
      }),
    ])
  ).toBeNull()
})

test('orders playable video variants by edge and keeps unlinked retry records', () => {
  const step = flowNode('step', 'task', 0, 0, {
    workflow: { generation: 'video', preferredResultNodeId: 'r1' },
  })
  const second = videoResult('r2', {
    label: 'Second',
    workflow: {
      sourceNodeId: 'step',
      seed: 22,
      model: 'veo-3',
      size: '1280x720',
      duration: 10,
    },
  })
  const preferred = videoResult('r1', {
    label: 'First',
    workflow: {
      sourceNodeId: 'step',
      seed: 11,
      model: 'veo-3',
      preferred: true,
    },
  })
  const unlinked = videoResult('r3', {
    workflow: { sourceNodeId: 'step', lastSeed: 33 },
  })
  const imageResult = flowNode('image-result', 'task-result', 340, 440, {
    workflow: { sourceNodeId: 'step', seed: 44 },
  })
  const foreign = videoResult('other', {
    workflow: { sourceNodeId: 'another-step', preferred: true },
  })
  const nodes = [step, second, preferred, unlinked, imageResult, foreign]
  const edges = [flowEdge('step', 'r2'), flowEdge('step', 'r1')]

  const variants = canvasVideoWorkbenchVariants('step', nodes, edges)

  expect(variants.map((variant) => variant.node.id)).toEqual(['r2', 'r1', 'r3'])
  expect(variants.map((variant) => variant.preferred)).toEqual([
    false,
    true,
    false,
  ])
  expect(variants[0]).toMatchObject({
    seed: 22,
    model: 'veo-3',
    size: '1280x720',
    duration: 10,
  })
  expect(variants[2].seed).toBe(33)
})

test('falls back to the per-result preferred flag without a step pointer', () => {
  const step = flowNode('step', 'task', 0, 0, {
    workflow: { generation: 'video' },
  })
  const first = videoResult('r1', {
    workflow: { sourceNodeId: 'step', preferred: false },
  })
  const second = videoResult('r2', {
    workflow: { sourceNodeId: 'step', preferred: true },
  })

  const variants = canvasVideoWorkbenchVariants(
    'step',
    [step, first, second],
    [flowEdge('step', 'r1'), flowEdge('step', 'r2')]
  )

  expect(variants.map((variant) => variant.preferred)).toEqual([false, true])
})

test('plays the preferred artifact and falls back to the settled task', () => {
  const step = flowNode('step', 'task', 0, 0, {
    workflow: { generation: 'video', taskId: 'fallback-task' },
  })
  const first = videoResult('r1')
  const second = videoResult('r2', {
    workflow: { sourceNodeId: 'step', preferred: true },
  })
  const variants = canvasVideoWorkbenchVariants(
    'step',
    [step, first, second],
    [flowEdge('step', 'r1'), flowEdge('step', 'r2')]
  )

  expect(canvasVideoWorkbenchSource(step, variants)).toEqual({
    taskId: 'task-r2',
    artifactKey: 'artifact-r2',
  })
  expect(canvasVideoWorkbenchSource(step, [])).toEqual({
    taskId: 'fallback-task',
  })
  expect(canvasVideoWorkbenchSource(null, [])).toBeNull()
})

test('adds a video step at the canvas add position', () => {
  expect(canvasVideoWorkbenchDefaultStep()).toEqual({
    kind: 'task',
    position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
    data: { workflow: { generation: 'video' } },
  })
})

test('appends the seed to a variant label only when one was recorded', () => {
  const node = flowNode('r1', 'video', 0, 0)

  expect(
    canvasVideoWorkbenchVariantLabel(
      { node, seed: 42, preferred: false },
      'Version 2'
    )
  ).toBe('Version 2 · 42')
  expect(
    canvasVideoWorkbenchVariantLabel({ node, preferred: false }, 'Version 2')
  ).toBe('Version 2')
})
