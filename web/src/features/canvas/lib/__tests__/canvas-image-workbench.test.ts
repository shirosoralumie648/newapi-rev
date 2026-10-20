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
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
  CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
} from '../../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
} from '../../types'
import {
  CANVAS_IMAGE_WORKBENCH_AFFIX_GAP,
  canvasImageWorkbenchAffixPlacements,
  canvasImageWorkbenchDefaultStep,
  canvasImageWorkbenchStep,
  canvasImageWorkbenchVariantLabel,
  canvasImageWorkbenchVariants,
} from '../canvas-image-workbench'

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

test('focuses the top-left image step and ignores video steps', () => {
  const nodes = [
    flowNode('video', 'task', 0, -200, {
      workflow: { generation: 'video' },
    }),
    flowNode('lower', 'task', 0, 120, {
      workflow: { generation: 'image' },
    }),
    flowNode('upper', 'task', 40, 20, {
      workflow: { generation: 'image' },
    }),
    flowNode('result', 'task-result', 400, 20, {
      workflow: { sourceNodeId: 'upper' },
    }),
  ]

  expect(canvasImageWorkbenchStep(nodes)?.id).toBe('upper')
  expect(
    canvasImageWorkbenchStep([
      flowNode('video-only', 'task', 0, 0, {
        workflow: { generation: 'video' },
      }),
    ])
  ).toBeNull()
})

test('orders variants by edge and keeps unlinked retry records of the same step', () => {
  const step = flowNode('step', 'task', 0, 0, {
    workflow: { generation: 'image', preferredResultNodeId: 'r1' },
  })
  const edgeSecond = flowNode('r2', 'task-result', 340, 0, {
    label: 'Second',
    workflow: {
      sourceNodeId: 'step',
      seed: 22,
      model: 'gpt-image-1',
      size: '1024x1024',
    },
  })
  const preferred = flowNode('r1', 'task-result', 340, 220, {
    label: 'First',
    workflow: {
      sourceNodeId: 'step',
      seed: 11,
      model: 'gpt-image-1',
      size: '1024x1024',
      preferred: true,
    },
  })
  const unlinked = flowNode('r3', 'task-result', 680, 0, {
    workflow: { sourceNodeId: 'step', lastSeed: 33 },
  })
  const foreign = flowNode('other', 'task-result', 0, 0, {
    workflow: { sourceNodeId: 'another-step', preferred: true },
  })
  const nodes = [step, edgeSecond, preferred, unlinked, foreign]
  const edges = [flowEdge('step', 'r2'), flowEdge('step', 'r1')]

  const variants = canvasImageWorkbenchVariants('step', nodes, edges)

  expect(variants.map((variant) => variant.node.id)).toEqual(['r2', 'r1', 'r3'])
  expect(variants.map((variant) => variant.preferred)).toEqual([
    false,
    true,
    false,
  ])
  expect(variants[0]).toMatchObject({
    seed: 22,
    model: 'gpt-image-1',
    size: '1024x1024',
  })
  expect(variants[2].seed).toBe(33)
})

test('falls back to the per-result preferred flag without a step pointer', () => {
  const step = flowNode('step', 'task', 0, 0, {
    workflow: { generation: 'image' },
  })
  const first = flowNode('r1', 'task-result', 340, 0, {
    workflow: { sourceNodeId: 'step', preferred: false },
  })
  const second = flowNode('r2', 'task-result', 340, 220, {
    workflow: { sourceNodeId: 'step', preferred: true },
  })

  const variants = canvasImageWorkbenchVariants(
    'step',
    [step, first, second],
    [flowEdge('step', 'r1'), flowEdge('step', 'r2')]
  )

  expect(variants.map((variant) => variant.preferred)).toEqual([false, true])
})

test('adds an image step at the canvas add position', () => {
  expect(canvasImageWorkbenchDefaultStep()).toEqual({
    kind: 'task',
    position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
    data: { workflow: { generation: 'image' } },
  })
})

test('lays the bloodline out below the board and marks every node affixed', () => {
  const step = flowNode('step', 'task', 40, 100, {
    workflow: { generation: 'image' },
  })
  const first = flowNode('r1', 'task-result', 40, 320, {
    workflow: { sourceNodeId: 'step' },
  })
  const second = flowNode('r2', 'task-result', 380, 320, {
    workflow: { sourceNodeId: 'step' },
  })
  const unrelated = flowNode('other', 'task-result', 0, 500, {
    workflow: { sourceNodeId: 'another-step' },
  })
  const nodes = [step, first, second, unrelated]
  const variants = canvasImageWorkbenchVariants('step', nodes, [
    flowEdge('step', 'r1'),
    flowEdge('step', 'r2'),
  ])
  const y =
    500 +
    CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y +
    CANVAS_IMAGE_WORKBENCH_AFFIX_GAP

  expect(canvasImageWorkbenchAffixPlacements(step, variants, nodes)).toEqual([
    { id: 'step', position: { x: 40, y }, data: { affixed: true } },
    {
      id: 'r1',
      position: { x: 40 + CANVAS_LINKED_NODE_OFFSET_X, y },
      data: { affixed: true },
    },
    {
      id: 'r2',
      position: { x: 40 + CANVAS_LINKED_NODE_OFFSET_X * 2, y },
      data: { affixed: true },
    },
  ])
})

test('keeps an already pinned row in place when pinning again', () => {
  const step = flowNode('step', 'task', 40, 768, {
    workflow: { generation: 'image' },
  })
  const first = flowNode('r1', 'task-result', 380, 768, {
    affixed: true,
    workflow: { sourceNodeId: 'step' },
  })
  const second = flowNode('r2', 'task-result', 720, 768, {
    affixed: true,
    workflow: { sourceNodeId: 'step' },
  })
  const unrelated = flowNode('other', 'task-result', 0, 500, {
    workflow: { sourceNodeId: 'another-step' },
  })
  const nodes = [step, first, second, unrelated]
  const variants = canvasImageWorkbenchVariants('step', nodes, [
    flowEdge('step', 'r1'),
    flowEdge('step', 'r2'),
  ])

  expect(
    canvasImageWorkbenchAffixPlacements(step, variants, nodes).map(
      (placement) => placement.position.y
    )
  ).toEqual([768, 768, 768])
})

test('appends the seed to a variant label only when one was recorded', () => {
  const node = flowNode('r1', 'task-result', 0, 0)

  expect(
    canvasImageWorkbenchVariantLabel(
      { node, seed: 42, preferred: false },
      'Version 2'
    )
  ).toBe('Version 2 · 42')
  expect(
    canvasImageWorkbenchVariantLabel({ node, preferred: false }, 'Version 2')
  ).toBe('Version 2')
})
