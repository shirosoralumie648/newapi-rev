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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { expect, test, vi } from 'vitest'

import { getTaskArtifacts } from '@/features/usage-logs/api'

import type { CanvasNodeData } from '../../types'
import { CanvasFlowNodeView, CanvasGroupNodeView } from '../canvas-node'

vi.mock('@/features/usage-logs/api', () => ({
  getTaskArtifacts: vi.fn(),
}))

function nodeProps(data: CanvasNodeData) {
  return {
    id: 'n1',
    data,
    selected: false,
    type: 'message',
    zIndex: 0,
    isConnectable: true,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<typeof CanvasFlowNodeView>[0]
}

function renderNode(data: CanvasNodeData) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        <CanvasFlowNodeView {...nodeProps(data)} />
      </ReactFlowProvider>
    </QueryClientProvider>
  )
}

test('marks a deleted source while keeping the saved snapshot visible', () => {
  renderNode({
    kind: 'message',
    text: 'snapshot text',
    snapshot: {
      sessionId: 'pgs_1',
      messageKey: 'm1',
      role: 'assistant',
      text: 'snapshot text',
    },
    ref: { sessionId: 'pgs_1', messageKey: 'm1' },
    sourceDeleted: true,
  })

  expect(screen.getByText('Source deleted')).toBeInTheDocument()
  expect(screen.getByText('snapshot text')).toBeInTheDocument()
  expect(
    screen.getByText(
      'The original was deleted. A saved snapshot is shown instead.'
    )
  ).toBeInTheDocument()
})

test('does not mark a node whose source still resolves', () => {
  renderNode({
    kind: 'message',
    text: 'live',
    ref: { sessionId: 'pgs_1', messageKey: 'm1' },
  })

  expect(screen.queryByText('Source deleted')).not.toBeInTheDocument()
})

test('shows the run state, output and failure of a workflow step', () => {
  renderNode({
    kind: 'model',
    workflow: {
      status: 'failed',
      model: 'gpt-4o',
      output: 'partial answer',
      error: 'upstream exploded',
    },
  })

  expect(screen.getByText('Failed')).toBeInTheDocument()
  expect(screen.getByText('partial answer')).toBeInTheDocument()
  expect(screen.getByText('upstream exploded')).toBeInTheDocument()
})

test('shows the durable task id of a generation step', () => {
  renderNode({
    kind: 'task',
    workflow: {
      status: 'succeeded',
      model: 'kling-v1',
      generation: 'video',
      taskId: 'task-1',
    },
  })

  expect(screen.getByText('Succeeded')).toBeInTheDocument()
  expect(screen.getByText(/task-1/)).toBeInTheDocument()
})

test('plays a video artifact of a settled task through the controlled URL', async () => {
  vi.mocked(getTaskArtifacts).mockResolvedValue({
    artifacts: [
      {
        key: 'out-1',
        type: 'video',
        content_url: '/api/task/task-1/artifacts/out-1/content',
      },
    ],
  })

  const { container } = renderNode({
    kind: 'video',
    label: 'kling-v1 · video',
    ref: { taskId: 'task-1', taskArtifactKey: 'out-1' },
  })

  await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
  expect(screen.getByText('kling-v1 · video')).toBeInTheDocument()
  expect(container.querySelector('video')).toHaveAttribute(
    'src',
    '/api/task/task-1/artifacts/out-1/content'
  )
  expect(getTaskArtifacts).toHaveBeenCalledWith('task-1')
})

test('plays an audio artifact with the audio element', async () => {
  vi.mocked(getTaskArtifacts).mockResolvedValue({
    artifacts: [
      {
        key: 'out-9',
        type: 'audio',
        content_url: '/api/task/task-9/artifacts/out-9/content',
      },
    ],
  })

  const { container } = renderNode({
    kind: 'audio',
    ref: { taskId: 'task-9' },
  })

  await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
  expect(container.querySelector('audio')).toHaveAttribute(
    'src',
    '/api/task/task-9/artifacts/out-9/content'
  )
  expect(container.querySelector('video')).toBeNull()
})

test('shows the empty state of a media node without a task reference', () => {
  const { container } = renderNode({ kind: 'video' })

  expect(screen.getByText('Empty node')).toBeInTheDocument()
  expect(container.querySelector('video')).toBeNull()
  expect(getTaskArtifacts).not.toHaveBeenCalled()
})

test('reports an unavailable media artifact instead of a broken player', async () => {
  vi.mocked(getTaskArtifacts).mockRejectedValue(new Error('gone'))

  const { container } = renderNode({
    kind: 'video',
    ref: { taskId: 'task-missing' },
  })

  expect(await screen.findByText('Preview unavailable')).toBeInTheDocument()
  expect(container.querySelector('video')).toBeNull()
})

test('renders a group as a dashed box without handles', () => {
  const client = new QueryClient()
  const { container } = render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        <CanvasGroupNodeView {...nodeProps({ kind: 'group', text: 'Scene' })} />
      </ReactFlowProvider>
    </QueryClientProvider>
  )

  expect(screen.getByText('Scene')).toBeInTheDocument()
  expect(container.querySelector('.react-flow__handle')).toBeNull()
})
