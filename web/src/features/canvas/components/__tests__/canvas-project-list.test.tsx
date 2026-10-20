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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { CanvasProjectSummary } from '../../types'
import { CanvasProjectList } from '../canvas-project-list'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const makeProject = (
  id: string,
  title: string,
  updatedAt: number
): CanvasProjectSummary => ({
  id,
  title,
  mode: 'infinite',
  nodeCount: 0,
  edgeCount: 0,
  documentBytes: 0,
  revision: 1,
  createdAt: updatedAt,
  updatedAt,
})

const projects = [
  makeProject('older', 'Older canvas', 1),
  makeProject('newer', 'Newest canvas', 2),
]

test('filters canvases by title and selects the chosen project', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CanvasProjectList
      activeProjectId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSelect={onSelect}
      projects={projects}
    />
  )

  await user.type(
    screen.getByRole('textbox', { name: 'Search canvases' }),
    'new'
  )
  expect(screen.queryByRole('button', { name: 'Older canvas' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Newest canvas' }))
  expect(onSelect).toHaveBeenCalledWith('newer')
})

test('creates a new canvas from the list header', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  render(
    <CanvasProjectList
      activeProjectId={null}
      onCreate={onCreate}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSelect={vi.fn()}
      projects={[]}
    />
  )

  await user.click(screen.getByRole('button', { name: 'New canvas' }))
  await user.click(
    await screen.findByRole('menuitem', { name: 'Infinite canvas' })
  )
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(onCreate).toHaveBeenCalledWith('infinite')
})

test('creates an image workbench project from the list header', async () => {
  const user = userEvent.setup()
  const onCreate = vi.fn()
  render(
    <CanvasProjectList
      activeProjectId={null}
      onCreate={onCreate}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSelect={vi.fn()}
      projects={[]}
    />
  )

  await user.click(screen.getByRole('button', { name: 'New canvas' }))
  await user.click(
    await screen.findByRole('menuitem', { name: 'Image workbench' })
  )
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(onCreate).toHaveBeenCalledWith('image')
})

test('confirms before moving a canvas to the trash', async () => {
  const user = userEvent.setup()
  const onDelete = vi.fn()
  render(
    <CanvasProjectList
      activeProjectId='older'
      onCreate={vi.fn()}
      onDelete={onDelete}
      onRename={vi.fn()}
      onSelect={vi.fn()}
      projects={projects}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Delete Older canvas' }))
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'Move canvas to trash?'
  )
  await user.click(screen.getByRole('button', { name: 'Move to trash' }))
  expect(onDelete).toHaveBeenCalledWith('older')
})
