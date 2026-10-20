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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
} from '@/features/canvas/constants'
import { useCanvasEditor } from '@/features/canvas/hooks/use-canvas-editor'
import type { CanvasAddedNode } from '@/features/canvas/hooks/use-canvas-editor'
import { useCanvasNodeArtifact } from '@/features/canvas/hooks/use-canvas-node-artifact'
import { useCanvasWorkflowOptions } from '@/features/canvas/hooks/use-canvas-workflow-options'
import { useCanvasWorkflowRunner } from '@/features/canvas/hooks/use-canvas-workflow-runner'
import { canvasDropEntries } from '@/features/canvas/lib/canvas-drop'
import {
  CANVAS_VIDEO_FRAME_MESSAGES,
  CanvasVideoFrameError,
  captureCanvasVideoFrame,
} from '@/features/canvas/lib/canvas-video-frame'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasServerProject,
} from '@/features/canvas/types'

import { CanvasVideoWorkbench } from '../canvas-video-workbench'

vi.mock('@/features/canvas/hooks/use-canvas-editor', () => ({
  useCanvasEditor: vi.fn(),
}))

vi.mock('@/features/canvas/hooks/use-canvas-workflow-options', () => ({
  useCanvasWorkflowOptions: vi.fn(),
}))

vi.mock('@/features/canvas/hooks/use-canvas-workflow-runner', () => ({
  useCanvasWorkflowRunner: vi.fn(),
}))

vi.mock('@/features/canvas/hooks/use-canvas-node-artifact', () => ({
  useCanvasNodeArtifact: vi.fn(),
}))

vi.mock('@/features/canvas/lib/canvas-drop', () => ({
  CanvasDropError: class CanvasDropError extends Error {},
  canvasDropEntries: vi.fn(),
}))

vi.mock('@/features/canvas/lib/canvas-video-frame', async () => {
  const actual = await vi.importActual<
    typeof import('@/features/canvas/lib/canvas-video-frame')
  >('@/features/canvas/lib/canvas-video-frame')
  return { ...actual, captureCanvasVideoFrame: vi.fn() }
})

vi.mock('@/features/canvas/components/canvas-node-workflow-fields', () => ({
  CanvasNodeWorkflowFields: () => <div>Workflow parameters</div>,
}))

vi.mock('@/features/canvas/components/canvas-node-result-fields', () => ({
  CanvasNodeResultFields: () => <div>Result parameters</div>,
}))

vi.mock('@/features/canvas/components/generation/canvas-task-queue', () => ({
  CanvasTaskQueue: () => <div>Queued submissions</div>,
}))

vi.mock('@/features/canvas/components/generation/canvas-task-list', () => ({
  CanvasTaskList: (props: { onlyActive?: boolean }) => (
    <div>Active video tasks {props.onlyActive ? 'filtered' : 'all'}</div>
  ),
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

function videoStep(): CanvasFlowNode {
  return flowNode('step', 'task', 40, 80, {
    workflow: {
      generation: 'video',
      model: 'veo-3',
      status: 'succeeded',
      preferredResultNodeId: 'v1',
    },
  })
}

function bloodline(): {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
} {
  const second = flowNode('v2', 'video', 340, 0, {
    label: 'Draft A',
    ref: { taskId: 'task-v2', taskArtifactKey: 'video-v2' },
    workflow: { sourceNodeId: 'step', seed: 22 },
  })
  const first = flowNode('v1', 'video', 340, 220, {
    label: 'Draft B',
    ref: { taskId: 'task-v1', taskArtifactKey: 'video-v1' },
    workflow: { sourceNodeId: 'step', seed: 11, preferred: true },
  })
  return {
    nodes: [videoStep(), second, first],
    edges: [flowEdge('step', 'v2'), flowEdge('step', 'v1')],
  }
}

function project(): CanvasServerProject {
  return {
    id: 'c1',
    title: 'Video project',
    mode: 'video',
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
    handleConnect: vi.fn(),
    handleEdgesChange: vi.fn(),
    setWorkflowPreferredResult: vi.fn(),
    updateNodeData: vi.fn(),
    addLinkedNode: vi.fn(),
  }
  vi.mocked(useCanvasEditor).mockReturnValue(
    editor as unknown as ReturnType<typeof useCanvasEditor>
  )
  return editor
}

function makeRunner(phase: 'idle' | 'running' = 'idle') {
  const runner = {
    phase,
    results: {},
    message: null,
    activeNodeId: null,
    clearMessage: vi.fn(),
    estimate: vi.fn(() => null),
    run: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
  }
  vi.mocked(useCanvasWorkflowRunner).mockReturnValue(
    runner as unknown as ReturnType<typeof useCanvasWorkflowRunner>
  )
  return runner
}

function renderWorkbench(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  onOpenImageWorkbench = vi.fn(async () => undefined)
) {
  const editor = makeEditor(nodes, edges)
  render(
    <CanvasVideoWorkbench
      onChange={vi.fn()}
      onOpenImageWorkbench={onOpenImageWorkbench}
      project={project()}
    />
  )
  return { editor, onOpenImageWorkbench }
}

const frameFile = new File(['frame'], 'video-frame-12.3s.jpg', {
  type: 'image/jpeg',
})

beforeEach(() => {
  makeRunner()
  vi.mocked(captureCanvasVideoFrame).mockReset()
  vi.mocked(canvasDropEntries).mockReset()
  vi.mocked(useCanvasWorkflowOptions).mockReturnValue({
    group: 'default',
    setGroup: vi.fn(),
    groups: [],
    models: [],
    modelCapabilities: {},
  } as unknown as ReturnType<typeof useCanvasWorkflowOptions>)
  vi.mocked(useCanvasNodeArtifact).mockImplementation(
    (taskId, artifactKey, expected) => ({
      artifact: taskId
        ? {
            key: artifactKey ?? 'video',
            type: expected,
            content_url: `https://cdn.example/${taskId}.mp4`,
          }
        : undefined,
      isPending: false,
      isError: false,
    })
  )
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:frame'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

test('adds the first video step from the empty workbench', async () => {
  const { editor } = renderWorkbench([], [])

  expect(
    screen.getByText('Add a video step to start generating.')
  ).toBeInTheDocument()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Add video step' }))

  expect(editor.addNodes).toHaveBeenCalledWith([
    {
      kind: 'task',
      position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
      data: { workflow: { generation: 'video' } },
    },
  ])
})

test('plays the preferred video and switches versions', async () => {
  const fixture = bloodline()
  renderWorkbench(fixture.nodes, fixture.edges)

  expect(screen.getByLabelText('Video player')).toHaveAttribute(
    'src',
    'https://cdn.example/task-v1.mp4'
  )
  expect(screen.getByText('Workflow parameters')).toBeInTheDocument()
  expect(screen.getByText('Result parameters')).toBeInTheDocument()

  const second = screen.getByRole('button', { name: 'Draft A · 22' })
  const preferred = screen.getByRole('button', { name: 'Draft B · 11' })
  expect(second).toHaveAttribute('aria-pressed', 'false')
  expect(preferred).toHaveAttribute('aria-pressed', 'true')

  await userEvent.setup().click(second)
  expect(
    vi.mocked(useCanvasEditor).mock.results[0].value.setWorkflowPreferredResult
  ).toHaveBeenCalledWith('v2')
})

test('captures the current frame and adds it as an image node', async () => {
  const step = videoStep()
  const fixture = bloodline()
  vi.mocked(captureCanvasVideoFrame).mockResolvedValue({
    blob: new Blob(['frame'], { type: 'image/jpeg' }),
    file: frameFile,
    seconds: 12.34,
  })
  vi.mocked(canvasDropEntries).mockResolvedValue([
    {
      kind: 'attachment',
      position: { x: 0, y: 0 },
      data: {
        label: frameFile.name,
        mediaType: frameFile.type,
        ref: { sessionId: 'c1', attachmentId: 'a1' },
      },
    },
  ])
  const { editor } = renderWorkbench(fixture.nodes, fixture.edges)

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Capture frame' }))
  expect(await screen.findByText('Captured at 12.3s')).toBeInTheDocument()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Add to canvas' }))

  await waitFor(() =>
    expect(canvasDropEntries).toHaveBeenCalledWith('c1', step.position, [
      frameFile,
    ])
  )
  expect(editor.addNodes).toHaveBeenCalledWith([
    {
      id: expect.any(String),
      kind: 'image',
      position: {
        x: step.position.x - CANVAS_LINKED_NODE_OFFSET_X,
        y: step.position.y,
      },
      data: {
        label: frameFile.name,
        mediaType: frameFile.type,
        ref: { sessionId: 'c1', attachmentId: 'a1' },
      },
    },
  ])
  const added = vi.mocked(editor.addNodes).mock.calls[0]?.[0]?.[0]
  expect(editor.handleConnect).toHaveBeenCalledWith({
    source: added?.id,
    target: step.id,
    sourceHandle: null,
    targetHandle: null,
  })
  expect(toast.success).toHaveBeenCalledWith('Frame added to the canvas.')
})

test('refuses a frame when the step already consumes four images', async () => {
  const step = videoStep()
  const images = Array.from({ length: 4 }, (_, index) =>
    flowNode(`image-${index}`, 'image', 0, index * 80, {
      ref: { sessionId: 'c1', attachmentId: `a${index}` },
    })
  )
  vi.mocked(captureCanvasVideoFrame).mockResolvedValue({
    blob: new Blob(['frame'], { type: 'image/jpeg' }),
    file: frameFile,
    seconds: 2,
  })
  vi.mocked(canvasDropEntries).mockResolvedValue([])
  renderWorkbench(
    [step, ...images],
    images.map((image) => flowEdge(image.id, step.id))
  )

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Capture frame' }))
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Add to canvas' }))

  expect(canvasDropEntries).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    'Too many reference images are connected to this step.'
  )
})

test('sends the captured frame to a new image workbench', async () => {
  const fixture = bloodline()
  vi.mocked(captureCanvasVideoFrame).mockResolvedValue({
    blob: new Blob(['frame'], { type: 'image/jpeg' }),
    file: frameFile,
    seconds: 2,
  })
  const { onOpenImageWorkbench } = renderWorkbench(fixture.nodes, fixture.edges)

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Capture frame' }))
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Open in image workbench' }))

  await waitFor(() =>
    expect(onOpenImageWorkbench).toHaveBeenCalledWith(frameFile)
  )
  expect(toast.success).toHaveBeenCalledWith('Sent to the image workbench.')
})

test('reports a frame that the browser could not read', async () => {
  const fixture = bloodline()
  vi.mocked(captureCanvasVideoFrame).mockRejectedValue(
    new CanvasVideoFrameError(CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED)
  )
  renderWorkbench(fixture.nodes, fixture.edges)

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Capture frame' }))

  expect(toast.error).toHaveBeenCalledWith(
    CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED
  )
})

test('opens the queue with active tasks only', async () => {
  const fixture = bloodline()
  renderWorkbench(fixture.nodes, fixture.edges)

  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Generation queue' }))

  expect(await screen.findByText('Queued submissions')).toBeInTheDocument()
  expect(screen.getByText('Active video tasks filtered')).toBeInTheDocument()
})
