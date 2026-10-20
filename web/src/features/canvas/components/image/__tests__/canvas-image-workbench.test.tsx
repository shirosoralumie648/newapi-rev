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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { beforeEach, expect, test, vi } from 'vitest'

import {
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
  CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
} from '@/features/canvas/constants'
import { useCanvasEditor } from '@/features/canvas/hooks/use-canvas-editor'
import type { CanvasAddedNode } from '@/features/canvas/hooks/use-canvas-editor'
import { useCanvasImageTools } from '@/features/canvas/hooks/use-canvas-image-tools'
import { useCanvasWorkflowOptions } from '@/features/canvas/hooks/use-canvas-workflow-options'
import { useCanvasWorkflowRunner } from '@/features/canvas/hooks/use-canvas-workflow-runner'
import { canvasDropEntries } from '@/features/canvas/lib/canvas-drop'
import { CANVAS_IMAGE_WORKBENCH_AFFIX_GAP } from '@/features/canvas/lib/canvas-image-workbench'
import { CANVAS_WORKFLOW_MESSAGES } from '@/features/canvas/lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasServerProject,
} from '@/features/canvas/types'

import { CanvasImageWorkbench } from '../canvas-image-workbench'

vi.mock('@/features/canvas/hooks/use-canvas-editor', () => ({
  useCanvasEditor: vi.fn(),
}))

vi.mock('@/features/canvas/hooks/use-canvas-image-tools', () => ({
  useCanvasImageTools: vi.fn(),
}))

vi.mock('@/features/canvas/hooks/use-canvas-workflow-options', () => ({
  useCanvasWorkflowOptions: vi.fn(),
}))

vi.mock('@/features/canvas/hooks/use-canvas-workflow-runner', () => ({
  useCanvasWorkflowRunner: vi.fn(),
}))

vi.mock('@/features/canvas/lib/canvas-drop', () => ({
  CanvasDropError: class CanvasDropError extends Error {},
  canvasDropEntries: vi.fn(),
}))

vi.mock('@/features/canvas/lib/canvas-workflow-images', () => ({
  CanvasWorkflowImageError: class CanvasWorkflowImageError extends Error {},
  readCanvasWorkflowImage: vi.fn(async () => 'blob:reference'),
}))

vi.mock('@/features/canvas/components/canvas-node-workflow-fields', () => ({
  CanvasNodeWorkflowFields: () => <div>Workflow parameters</div>,
}))

vi.mock('@/features/canvas/components/canvas-node-result-fields', () => ({
  CanvasNodeResultFields: () => <div>Result parameters</div>,
}))

vi.mock('@/features/canvas/components/canvas-image-tools-dialog', () => ({
  CanvasImageToolsDialog: () => null,
}))

vi.mock('@/features/canvas/components/canvas-run-budget-dialog', () => ({
  CanvasRunBudgetDialog: () => null,
}))

vi.mock('@/components/workspace-inspector', () => ({
  WorkspaceInspector: (props: {
    children: ReactNode
    main: ReactNode
    open: boolean
  }) => (
    <div>
      <div>{props.main}</div>
      {props.open ? <aside>{props.children}</aside> : null}
    </div>
  ),
}))

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  })
  return { toast }
})

const PREVIEW_A = 'data:image/png;base64,QQ=='
const PREVIEW_B = 'data:image/png;base64,Qg=='

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

function imageStep(): CanvasFlowNode {
  return flowNode('step', 'task', 0, 0, {
    workflow: {
      generation: 'image',
      model: 'gpt-image-1',
      status: 'succeeded',
      preferredResultNodeId: 'v1',
    },
  })
}

function bloodline(): {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
} {
  const step = imageStep()
  const second = flowNode('v2', 'task-result', 340, 0, {
    label: 'Draft A',
    workflow: { sourceNodeId: 'step', seed: 22 },
  })
  const first = flowNode('v1', 'task-result', 340, 220, {
    label: 'Draft B',
    workflow: { sourceNodeId: 'step', seed: 11, preferred: true },
  })
  return {
    nodes: [step, second, first],
    edges: [flowEdge('step', 'v2'), flowEdge('step', 'v1')],
  }
}

function project(): CanvasServerProject {
  return {
    id: 'c1',
    title: 'Image project',
    mode: 'image',
    nodeCount: 0,
    edgeCount: 0,
    documentBytes: 0,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    document: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    },
  }
}

function makeEditor(nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]) {
  const editor = {
    nodes,
    edges,
    addNodes: vi.fn((entries: CanvasAddedNode[]) => entries.length),
    affixNodes: vi.fn(() => true),
    handleConnect: vi.fn(),
    handleEdgesChange: vi.fn(),
    setWorkflowPreferredResult: vi.fn(),
    updateNodeData: vi.fn(),
  }
  vi.mocked(useCanvasEditor).mockReturnValue(
    editor as unknown as ReturnType<typeof useCanvasEditor>
  )
  return editor
}

function makeRunner(
  results: Record<string, string[]> = {},
  phase: 'idle' | 'running' = 'idle'
) {
  vi.mocked(useCanvasWorkflowRunner).mockReturnValue({
    phase,
    results,
    message: null,
    clearMessage: vi.fn(),
    estimate: vi.fn(() => null),
    run: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
  } as unknown as ReturnType<typeof useCanvasWorkflowRunner>)
}

function renderWorkbench(nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]) {
  const editor = makeEditor(nodes, edges)
  return {
    ...render(<CanvasImageWorkbench project={project()} onChange={vi.fn()} />),
    editor,
  }
}

beforeEach(() => {
  makeRunner()
  vi.mocked(useCanvasWorkflowOptions).mockReturnValue({
    group: 'default',
    setGroup: vi.fn(),
    groups: [],
    models: [],
    modelCapabilities: {},
  } as unknown as ReturnType<typeof useCanvasWorkflowOptions>)
  vi.mocked(useCanvasImageTools).mockReturnValue({
    tool: null,
    source: null,
    sourceSize: null,
    busy: false,
    message: null,
    open: vi.fn(),
    close: vi.fn(),
    clearMessage: vi.fn(),
    crop: vi.fn(async () => true),
    redraw: vi.fn(async () => true),
    upscale: vi.fn(async () => true),
    outpaint: vi.fn(async () => true),
    backgroundRemoval: vi.fn(async () => true),
    styleReference: vi.fn(async () => true),
  } as unknown as ReturnType<typeof useCanvasImageTools>)
  makeRunner()
})

test('adds the first image step from the empty workbench', async () => {
  const { editor } = renderWorkbench([], [])

  expect(
    screen.getByText('Add an image step to start generating.')
  ).toBeInTheDocument()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Add image step' }))

  expect(editor.addNodes).toHaveBeenCalledWith([
    {
      kind: 'task',
      position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
      data: { workflow: { generation: 'image' } },
    },
  ])
})

test('shows the preferred image, versions, parameters and zoom toolbar', async () => {
  const fixture = bloodline()
  makeRunner({ step: [PREVIEW_A, PREVIEW_B] })
  const { editor } = renderWorkbench(fixture.nodes, fixture.edges)

  expect(screen.getByRole('img', { name: 'Generated image' })).toHaveAttribute(
    'src',
    PREVIEW_B
  )
  expect(screen.getByText('Workflow parameters')).toBeInTheDocument()
  expect(screen.getByText('Result parameters')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Crop image' })).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Add reference image' })
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Pin to canvas' })
  ).toBeInTheDocument()

  const second = screen.getByRole('button', { name: 'Draft A · 22' })
  const preferred = screen.getByRole('button', { name: 'Draft B · 11' })
  expect(second).toHaveAttribute('aria-pressed', 'false')
  expect(preferred).toHaveAttribute('aria-pressed', 'true')

  await userEvent.setup().click(second)
  expect(editor.setWorkflowPreferredResult).toHaveBeenCalledWith('v2')

  await userEvent.setup().click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent(
    '125%'
  )
})

test('locks the version strip while a run is in flight', () => {
  const fixture = bloodline()
  makeRunner({ step: [PREVIEW_A, PREVIEW_B] }, 'running')
  renderWorkbench(fixture.nodes, fixture.edges)

  expect(screen.getByRole('button', { name: 'Draft A · 22' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Draft B · 11' })).toBeDisabled()
})

test('pins the focused bloodline to the canvas board in one action', async () => {
  const fixture = bloodline()
  const { editor } = renderWorkbench(fixture.nodes, fixture.edges)
  const y =
    CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y + CANVAS_IMAGE_WORKBENCH_AFFIX_GAP

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Pin to canvas' }))

  expect(editor.affixNodes).toHaveBeenCalledWith([
    { id: 'step', position: { x: 0, y }, data: { affixed: true } },
    {
      id: 'v2',
      position: { x: CANVAS_LINKED_NODE_OFFSET_X, y },
      data: { affixed: true },
    },
    {
      id: 'v1',
      position: { x: CANVAS_LINKED_NODE_OFFSET_X * 2, y },
      data: { affixed: true },
    },
  ])
  expect(toast.success).toHaveBeenCalledWith('Pinned to the canvas board.')
})

test('mounts connected reference images and removes their edge', async () => {
  const step = imageStep()
  const reference = flowNode('ref', 'attachment', -340, 0, {
    label: 'ref.png',
    mediaType: 'image/png',
    ref: { sessionId: 's1', attachmentId: 'a1' },
  })
  const { editor } = renderWorkbench(
    [step, reference],
    [flowEdge('ref', 'step')]
  )

  expect(await screen.findByRole('img', { name: 'ref.png' })).toHaveAttribute(
    'src',
    'blob:reference'
  )

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Remove reference image' }))
  expect(editor.handleEdgesChange).toHaveBeenCalledWith([
    { type: 'remove', id: 'ref-step' },
  ])
})

test('uploads a reference image and wires it to the focused step', async () => {
  const step = imageStep()
  vi.mocked(canvasDropEntries).mockResolvedValue([
    {
      kind: 'attachment',
      position: { x: 0, y: 0 },
      data: {
        label: 'ref.png',
        mediaType: 'image/png',
        ref: { sessionId: 's1', attachmentId: 'a1' },
      },
    },
  ])
  const { editor, container } = renderWorkbench([step], [])

  const input = container.querySelector('input[type="file"]')
  expect(input).not.toBeNull()
  await userEvent
    .setup()
    .upload(
      input as HTMLInputElement,
      new File(['image'], 'ref.png', { type: 'image/png' })
    )

  await waitFor(() => expect(editor.addNodes).toHaveBeenCalledTimes(1))
  const entries = vi.mocked(editor.addNodes).mock.calls[0][0]
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    kind: 'attachment',
    position: {
      x: step.position.x - CANVAS_LINKED_NODE_OFFSET_X,
      y: step.position.y,
    },
  })
  expect(entries[0].id).toBeTruthy()
  expect(editor.handleConnect).toHaveBeenCalledWith({
    source: entries[0].id,
    target: 'step',
    sourceHandle: null,
    targetHandle: null,
  })
  expect(toast.success).toHaveBeenCalledWith('Reference image added.')
})

test('refuses references beyond the step image limit before uploading', async () => {
  const step = imageStep()
  const mounted = Array.from({ length: 3 }, (_, index) =>
    flowNode(`ref${index}`, 'attachment', -340, index * 220, {
      label: `ref${index}.png`,
      mediaType: 'image/png',
      ref: { sessionId: 's1', attachmentId: `a${index}` },
    })
  )
  const edges = mounted.map((node) => flowEdge(node.id, 'step'))
  vi.mocked(canvasDropEntries).mockClear()
  const { container } = renderWorkbench([step, ...mounted], edges)

  const input = container.querySelector('input[type="file"]')
  expect(input).not.toBeNull()
  await userEvent
    .setup()
    .upload(input as HTMLInputElement, [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ])

  expect(canvasDropEntries).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    CANVAS_WORKFLOW_MESSAGES.IMAGE_INPUT_LIMIT
  )
})
