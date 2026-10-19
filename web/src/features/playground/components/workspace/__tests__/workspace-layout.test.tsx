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
  inspectorView: null,
  inspector: <div>Inspector body</div>,
  onToggleInspector: vi.fn(),
  onCloseInspector: vi.fn(),
}

test('desktop shows chat and inspector side by side without a modal', () => {
  render(
    <PlaygroundWorkspace {...baseProps} inspectorView='artifacts'>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.getByText('Chat body')).toBeVisible()
  expect(screen.getByText('Inspector body')).toBeVisible()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('desktop hides the inspector and reports the requested view', async () => {
  const user = userEvent.setup()
  const onToggleInspector = vi.fn()
  render(
    <PlaygroundWorkspace {...baseProps} onToggleInspector={onToggleInspector}>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.queryByText('Inspector body')).toBeNull()
  const artifacts = screen.getByRole('button', { name: 'Artifacts' })
  const canvases = screen.getByRole('button', { name: 'Canvases' })
  expect(artifacts).toHaveAttribute('aria-pressed', 'false')
  expect(canvases).toHaveAttribute('aria-pressed', 'false')
  await user.click(artifacts)
  expect(onToggleInspector).toHaveBeenCalledWith('artifacts')
  await user.click(canvases)
  expect(onToggleInspector).toHaveBeenCalledWith('canvas')
  await user.click(screen.getByRole('button', { name: 'Memory' }))
  expect(onToggleInspector).toHaveBeenCalledWith('memory')
})

test('desktop marks the active canvas inspector view', () => {
  render(
    <PlaygroundWorkspace {...baseProps} inspectorView='canvas'>
      <div>Chat body</div>
    </PlaygroundWorkspace>
  )

  expect(screen.getByRole('button', { name: 'Canvases' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.getByRole('button', { name: 'Artifacts' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  expect(screen.getByText('Inspector body')).toBeVisible()
})

test('mobile presents the inspector in a sheet closing to the controller', async () => {
  window.innerWidth = 375
  const user = userEvent.setup()
  const onCloseInspector = vi.fn()
  render(
    <PlaygroundWorkspace
      {...baseProps}
      inspectorView='artifacts'
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
