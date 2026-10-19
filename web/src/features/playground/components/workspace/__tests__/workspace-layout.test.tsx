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
  onOrganize: vi.fn(),
  onDelete: vi.fn(),
  inspectorView: null,
  inspector: <div>Inspector body</div>,
  onCloseInspector: vi.fn(),
  syncLabel: 'Playground',
  usagePanel: <div>Usage panel</div>,
}

test('desktop shows the conversation and its conversation-domain inspector', () => {
  render(
    <PlaygroundWorkspace {...baseProps} inspectorView='presets'>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.getByText('Chat body')).toBeVisible()
  expect(screen.getByText('Inspector body')).toBeVisible()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByText('Usage panel')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Playground')
})

test('the top bar no longer exposes the creation-domain entries', () => {
  render(
    <PlaygroundWorkspace {...baseProps}>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  for (const name of ['Generate', 'Canvases', 'Artifacts', 'Library']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  expect(screen.getByText('Usage panel')).toBeVisible()
})

test('desktop hides the inspector when no conversation panel is open', () => {
  render(
    <PlaygroundWorkspace {...baseProps}>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.queryByText('Inspector body')).toBeNull()
})

test('mobile presents the inspector in a sheet closing to the controller', async () => {
  window.innerWidth = 375
  const user = userEvent.setup()
  const onCloseInspector = vi.fn()
  render(
    <PlaygroundWorkspace
      {...baseProps}
      inspectorView='presets'
      onCloseInspector={onCloseInspector}
    >
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Inspector body')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(onCloseInspector).toHaveBeenCalledTimes(1))
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
