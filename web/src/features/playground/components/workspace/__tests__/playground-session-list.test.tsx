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

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import type { PlaygroundSession } from '../../../types'
import { PlaygroundSessionList } from '../playground-session-list'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const makeSession = (
  id: string,
  title: string,
  updatedAt: number
): PlaygroundSession => ({
  id,
  title,
  updatedAt,
  createdAt: updatedAt,
  config: { ...DEFAULT_CONFIG },
  parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
  systemPrompt: '',
  messages: [],
})

const sessions = [
  makeSession('older', 'Older conversation', 1),
  makeSession('newer', 'Newest conversation', 2),
]

test('filters sessions by title and switches the selected conversation', async () => {
  const user = userEvent.setup()
  const onSwitch = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSwitch={onSwitch}
      sessions={sessions}
    />
  )

  await user.type(
    screen.getByRole('textbox', { name: 'Search conversations' }),
    'new'
  )
  expect(
    screen.queryByRole('button', { name: 'Older conversation' })
  ).toBeNull()
  const newest = screen.getByRole('button', { name: 'Newest conversation' })
  await user.click(newest)
  expect(onSwitch).toHaveBeenCalledWith('newer')
})

test('requires a non-empty title before saving a rename', async () => {
  const user = userEvent.setup()
  const onRename = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onRename={onRename}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Rename Older conversation' })
  )
  const titleInput = screen.getByRole('textbox', { name: 'Session name' })
  await user.clear(titleInput)
  await user.click(screen.getByRole('button', { name: 'Save name' }))

  expect(onRename).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeVisible()
})

test('confirms deletion before removing a session', async () => {
  const user = userEvent.setup()
  const onDelete = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={onDelete}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete Older conversation' })
  )
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Delete' }))
  expect(onDelete).toHaveBeenCalledWith('older')
})
