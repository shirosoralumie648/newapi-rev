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
import { beforeEach, expect, test, vi } from 'vitest'

import {
  createCanvasProject,
  getCanvasProject,
  listCanvasProjects,
  updateCanvasProject,
} from '../../api'
import { CanvasSendDialog } from '../canvas-send-dialog'

vi.mock('../../api', () => ({
  createCanvasProject: vi.fn(),
  getCanvasProject: vi.fn(),
  listCanvasProjects: vi.fn(),
  updateCanvasProject: vi.fn(),
}))

const summary = {
  id: 'c1',
  title: 'Board A',
  mode: 'infinite' as const,
  nodeCount: 2,
  edgeCount: 0,
  documentBytes: 10,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
}

const project = { ...summary, document: { nodes: [], edges: [] } }

const seeds = [
  {
    kind: 'prompt' as const,
    text: 'hi',
    ref: { sessionId: 'pgs_1', messageKey: 'm1' },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

test('appends the seeds to the canvas the user picks', async () => {
  const user = userEvent.setup()
  const onOpenChange = vi.fn()
  const onSent = vi.fn()
  vi.mocked(listCanvasProjects).mockResolvedValue([summary])
  vi.mocked(getCanvasProject).mockResolvedValue(project)
  vi.mocked(updateCanvasProject).mockResolvedValue({ ...project, revision: 2 })

  render(
    <CanvasSendDialog
      open
      onOpenChange={onOpenChange}
      seeds={seeds}
      onSent={onSent}
    />
  )

  await user.click(await screen.findByRole('button', { name: /Board A/ }))
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(onSent).toHaveBeenCalledWith({ ...project, revision: 2 })

  const [id, input] = vi.mocked(updateCanvasProject).mock.calls[0]
  expect(id).toBe('c1')
  expect(input.revision).toBe(1)
  expect((input.document as { nodes: unknown[] }).nodes).toHaveLength(1)
  expect(
    (input.document as { nodes: { data: unknown }[] }).nodes[0].data
  ).toEqual({
    kind: 'prompt',
    text: 'hi',
    ref: { sessionId: 'pgs_1', messageKey: 'm1' },
  })
})

test('creates a new canvas that already holds the seeds', async () => {
  const user = userEvent.setup()
  const onOpenChange = vi.fn()
  vi.mocked(listCanvasProjects).mockResolvedValue([])
  vi.mocked(createCanvasProject).mockResolvedValue(project)

  render(
    <CanvasSendDialog
      open
      onOpenChange={onOpenChange}
      seeds={seeds}
      onSent={vi.fn()}
    />
  )

  await screen.findByText('No canvas projects yet')
  await user.type(
    screen.getByRole('textbox', { name: 'Canvas name' }),
    'New Board'
  )
  await user.click(screen.getByRole('button', { name: 'Add to canvas' }))
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

  const input = vi.mocked(createCanvasProject).mock.calls[0][0]
  expect(input.title).toBe('New Board')
  expect((input.document as { nodes: unknown[] }).nodes).toHaveLength(1)
})

test('surfaces a retry when canvases fail to load', async () => {
  const user = userEvent.setup()
  vi.mocked(listCanvasProjects)
    .mockRejectedValueOnce(new Error('down'))
    .mockResolvedValueOnce([summary])

  render(<CanvasSendDialog open onOpenChange={vi.fn()} seeds={seeds} />)

  await user.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByRole('button', { name: /Board A/ })
  ).toBeInTheDocument()
})
