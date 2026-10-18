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

import { getCanvasProject, listCanvasProjects } from '@/features/canvas/api'

import { PlaygroundCanvasPanel } from '../playground-canvas-panel'

vi.mock('@/features/canvas/api', () => ({
  getCanvasProject: vi.fn(),
  listCanvasProjects: vi.fn(),
}))

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const first = {
  id: 'c1',
  title: 'Board A',
  nodeCount: 1,
  edgeCount: 0,
  documentBytes: 10,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
}

const second = { ...first, id: 'c2', title: 'Board B' }

const firstProject = {
  ...first,
  document: {
    nodes: [
      {
        id: 'n1',
        type: 'text' as const,
        position: { x: 0, y: 0 },
        data: { kind: 'text', text: 'Hello node' },
      },
    ],
    edges: [],
  },
}

const secondProject = {
  ...second,
  document: {
    nodes: [
      {
        id: 'n2',
        type: 'message' as const,
        position: { x: 0, y: 0 },
        data: {
          kind: 'message',
          text: 'Second preview',
          ref: { sessionId: 'pgs_1', messageKey: 'm1' },
        },
      },
    ],
    edges: [],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('previews the focused canvas and jumps to the full editor', async () => {
  const user = userEvent.setup()
  const onOpenProject = vi.fn()
  vi.mocked(listCanvasProjects).mockResolvedValue([first, second])
  vi.mocked(getCanvasProject).mockResolvedValue(secondProject)

  render(
    <PlaygroundCanvasPanel activeProjectId='c2' onOpenProject={onOpenProject} />
  )

  expect(await screen.findByText('Second preview')).toBeVisible()
  expect(vi.mocked(getCanvasProject)).toHaveBeenCalledWith('c2')

  await user.click(screen.getByRole('button', { name: 'Open canvas' }))
  expect(onOpenProject).toHaveBeenCalledWith('c2')
})

test('switching the selected canvas reloads its preview', async () => {
  const user = userEvent.setup()
  vi.mocked(listCanvasProjects).mockResolvedValue([first, second])
  vi.mocked(getCanvasProject).mockImplementation(async (id: string) =>
    id === 'c1' ? firstProject : secondProject
  )

  render(<PlaygroundCanvasPanel activeProjectId='c2' onOpenProject={vi.fn()} />)

  await screen.findByText('Second preview')
  await user.click(screen.getByRole('button', { name: /Board A/ }))
  await waitFor(() => expect(screen.getByText('Hello node')).toBeVisible())
  expect(vi.mocked(getCanvasProject)).toHaveBeenLastCalledWith('c1')
})

test('shows an empty state when the account has no canvases', async () => {
  vi.mocked(listCanvasProjects).mockResolvedValue([])

  render(
    <PlaygroundCanvasPanel activeProjectId={null} onOpenProject={vi.fn()} />
  )

  expect(await screen.findByText('No canvas projects yet')).toBeVisible()
})

test('a refresh signal re-reads the list after a canvas leaves the trash', async () => {
  vi.mocked(listCanvasProjects)
    .mockResolvedValueOnce([first])
    .mockResolvedValueOnce([first, second])
  vi.mocked(getCanvasProject).mockResolvedValue(firstProject)

  const { rerender } = render(
    <PlaygroundCanvasPanel
      activeProjectId={null}
      onOpenProject={vi.fn()}
      refreshSignal={0}
    />
  )

  expect(await screen.findByRole('button', { name: /Board A/ })).toBeVisible()
  expect(screen.queryByRole('button', { name: /Board B/ })).toBeNull()

  rerender(
    <PlaygroundCanvasPanel
      activeProjectId={null}
      onOpenProject={vi.fn()}
      refreshSignal={1}
    />
  )

  expect(await screen.findByRole('button', { name: /Board B/ })).toBeVisible()
  expect(vi.mocked(listCanvasProjects)).toHaveBeenCalledTimes(2)
})
