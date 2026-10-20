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

import type { PlaygroundCommand } from '../../../lib/command/playground-commands'
import { PlaygroundCommandPalette } from '../playground-command-palette'

function command(
  overrides: Partial<PlaygroundCommand> & Pick<PlaygroundCommand, 'title'>
): PlaygroundCommand {
  return {
    id: 'command',
    group: 'workspace',
    ...overrides,
    run: overrides.run ?? vi.fn(),
  }
}

test('the empty palette lists actions but hides search-only results', () => {
  const newConversation = vi.fn()
  render(
    <PlaygroundCommandPalette
      commands={[
        command({ id: 'new', title: 'New conversation', run: newConversation }),
        command({
          id: 'session',
          title: 'Switch to Alpha',
          searchOnly: true,
        }),
      ]}
      onOpenChange={vi.fn()}
      open
    />
  )

  expect(screen.getByText('New conversation')).toBeVisible()
  expect(screen.queryByText('Switch to Alpha')).toBeNull()

  return userEvent.click(screen.getByText('New conversation')).then(() => {
    expect(newConversation).toHaveBeenCalledTimes(1)
  })
})

test('a filtered command runs with the keyboard', async () => {
  const run = vi.fn()
  render(
    <PlaygroundCommandPalette
      commands={[command({ id: 'search', title: 'Search messages', run })]}
      onOpenChange={vi.fn()}
      open
    />
  )

  await userEvent.type(screen.getByRole('combobox'), 'search')
  await userEvent.keyboard('{ArrowDown}{Enter}')

  expect(run).toHaveBeenCalledTimes(1)
})

test('escape asks the controller to close the palette', async () => {
  const onOpenChange = vi.fn()
  render(
    <PlaygroundCommandPalette
      commands={[command({ title: 'New conversation' })]}
      onOpenChange={onOpenChange}
      open
    />
  )

  await userEvent.keyboard('{Escape}')

  expect(onOpenChange).toHaveBeenCalledWith(false)
})
