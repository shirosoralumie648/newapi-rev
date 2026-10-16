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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { PlaygroundWorkspace } from '../playground-workspace'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const originalInnerWidth = window.innerWidth

afterEach(() => {
  window.innerWidth = originalInnerWidth
})

const baseProps = {
  sessions: [],
  activeSessionId: null,
  onCreate: vi.fn(),
  onSwitch: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
}

test('desktop shows chat and artifact panel side by side without a modal', () => {
  render(
    <PlaygroundWorkspace
      {...baseProps}
      artifactsOpen
      artifactPanel={<div>Artifact body</div>}
    >
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.getByText('Chat body')).toBeVisible()
  expect(screen.getByText('Artifact body')).toBeVisible()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('desktop hides the artifact panel and reports toggle state', async () => {
  const user = userEvent.setup()
  const onToggleArtifacts = vi.fn()
  render(
    <PlaygroundWorkspace
      {...baseProps}
      artifactsOpen={false}
      artifactPanel={<div>Artifact body</div>}
      onToggleArtifacts={onToggleArtifacts}
    >
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.queryByText('Artifact body')).toBeNull()
  const toggle = screen.getByRole('button', { name: 'Artifacts' })
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await user.click(toggle)
  expect(onToggleArtifacts).toHaveBeenCalledTimes(1)
})

test('mobile presents the artifact panel in a sheet closing to the controller', async () => {
  window.innerWidth = 375
  const user = userEvent.setup()
  const onCloseArtifacts = vi.fn()
  render(
    <PlaygroundWorkspace
      {...baseProps}
      artifactsOpen
      artifactPanel={<div>Artifact body</div>}
      onToggleArtifacts={vi.fn()}
      onCloseArtifacts={onCloseArtifacts}
    >
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Artifact body')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(onCloseArtifacts).toHaveBeenCalledTimes(1))
})

test('mobile opens the conversation list from the header button', async () => {
  window.innerWidth = 375
  const user = userEvent.setup()
  render(
    <PlaygroundWorkspace {...baseProps}>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  const open = await screen.findByRole('button', {
    name: 'Open conversations',
  })
  await user.click(open)
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Conversations')).toBeVisible()
})
