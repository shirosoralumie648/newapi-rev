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
import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, expect, test, vi } from 'vitest'

import type { CanvasNodeData } from '@/features/canvas/types'
import { api } from '@/lib/api'

import { PlaygroundSharedPage } from '../components/share/playground-shared-page'
import { SharedCanvasNodeView } from '../components/share/shared-canvas-node'

const clients: QueryClient[] = []

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <PlaygroundSharedPage token='share-token' />
    </QueryClientProvider>
  )
}

function sharedCanvasNodeProps(data: CanvasNodeData) {
  return {
    id: 'n1',
    data,
    selected: false,
    type: data.kind,
    zIndex: 0,
    isConnectable: false,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<typeof SharedCanvasNodeView>[0]
}

function renderSharedCanvasNode(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      <SharedCanvasNodeView {...sharedCanvasNodeProps(data)} />
    </ReactFlowProvider>
  )
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

test('a public share renders text, tool summaries and attachment placeholders without attachment bytes', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        title: 'Shared notes',
        opening_message: 'Welcome to the shared copy',
        messages: [
          {
            key: 'm1',
            from: 'user',
            content: 'Hello <script>alert(1)</script>',
            attachments: [{ filename: 'diagram.png', media_type: 'image/png' }],
          },
          {
            key: 'm2',
            from: 'assistant',
            content: 'Here is the answer.',
            tool_calls: [{ name: 'lookup', status: 'completed' }],
          },
        ],
      },
    },
  })

  mount()

  expect(
    await screen.findByRole('heading', { name: 'Shared notes' })
  ).toBeVisible()
  expect(screen.getByText('Welcome to the shared copy')).toBeVisible()
  expect(screen.getByText('Hello <script>alert(1)</script>')).toBeVisible()
  expect(document.querySelector('script')).toBeNull()
  expect(screen.getByText('lookup · Completed')).toBeVisible()
  expect(screen.getByText('diagram.png')).toBeVisible()
  expect(screen.getByText('image/png')).toBeVisible()
  expect(
    screen.getByText(
      'Attachment content is not available in shared conversations.'
    )
  ).toBeVisible()
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('a[href*="attachment"]')).toBeNull()
  expect(document.title).toContain('Shared notes')
  expect(
    document.querySelector('meta[name="robots"]')?.getAttribute('content')
  ).toBe('noindex, nofollow, noarchive')
  expect(
    document.querySelector('meta[name="referrer"]')?.getAttribute('content')
  ).toBe('no-referrer')
})

test('a revoked, expired or missing share link shows the same not-found state', async () => {
  vi.spyOn(api, 'get').mockRejectedValue({
    response: {
      status: 404,
      data: {
        success: false,
        code: 'PLAYGROUND_SHARE_NOT_FOUND',
        message: 'Shared conversation not found.',
      },
    },
  })

  mount()

  expect(await screen.findByText('Shared link not found')).toBeVisible()
  expect(
    screen.getByText('This link may have been revoked or has expired.')
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

test('a canvas share renders its read-only board shell without media requests', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        kind: 'canvas',
        title: 'Shared board',
        updated_at: 100,
        document: { nodes: [], edges: [] },
      },
    },
  })

  mount()

  expect(
    await screen.findByRole('heading', { name: 'Shared board' })
  ).toBeVisible()
  expect(screen.getByText('Read-only shared canvas')).toBeVisible()
  expect(screen.getByText('The shared canvas has no nodes.')).toBeVisible()
  expect(
    screen.getByText(
      'The owner of this canvas can revoke this link at any time.'
    )
  ).toBeVisible()
  expect(document.title).toContain('Read-only shared canvas')
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('a[href*="attachment"]')).toBeNull()
})

test('a shared canvas renders sanitized node previews from its document', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        kind: 'canvas',
        title: 'Shared board',
        updated_at: 100,
        document: {
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'n-text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { kind: 'text', text: 'Visible prompt' },
            },
            {
              id: 'n-artifact',
              type: 'artifact',
              position: { x: 280, y: 0 },
              data: {
                kind: 'artifact',
                label: 'chart.png',
                mediaType: 'image/png',
                snapshot: { text: 'Chart preview' },
              },
            },
          ],
          edges: [{ id: 'e1', source: 'n-text', target: 'n-artifact' }],
        },
      },
    },
  })

  mount()

  expect(await screen.findByText('Visible prompt')).toBeVisible()
  expect(screen.getByText('Chart preview')).toBeVisible()
  expect(screen.getByText('chart.png')).toBeVisible()
  expect(screen.getByText('image/png')).toBeVisible()
  expect(screen.getByText('Preview not available')).toBeVisible()
  // Only the sanitized snapshot was requested; the page never asks for
  // attachment or artifact bytes.
  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][0]).toBe('/api/playground/shared/share-token')
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('a[href*="attachment"]')).toBeNull()
})

test('a shared media node exposes only its label and declared type', () => {
  renderSharedCanvasNode({
    kind: 'artifact',
    label: 'chart.png',
    mediaType: 'image/png',
    ref: {
      sessionId: 'pgs_secret',
      attachmentId: 'pgf_secret',
      taskId: 'task_secret',
    },
  })

  expect(screen.getByText('Artifact')).toBeVisible()
  expect(screen.getByText('chart.png')).toBeVisible()
  expect(screen.getByText('image/png')).toBeVisible()
  expect(screen.getByText('Preview not available')).toBeVisible()
  expect(document.body.textContent).not.toContain('pgs_secret')
  expect(document.body.textContent).not.toContain('pgf_secret')
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('a')).toBeNull()
})

test('a shared task result shows its bounded text preview and status', () => {
  renderSharedCanvasNode({
    kind: 'task-result',
    workflow: {
      status: 'succeeded',
      output: 'Generated result',
      resultImageCount: 1,
      taskId: 'task_secret',
    },
  })

  expect(screen.getByText('Task result')).toBeVisible()
  expect(screen.getByText('Succeeded')).toBeVisible()
  expect(screen.getByText('Generated result')).toBeVisible()
  expect(screen.getByText('Preview not available')).toBeVisible()
  expect(document.body.textContent).not.toContain('task_secret')
})
