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
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { messageJumpWindow } from '../../../lib/message/message-index-utils'
import type { Message } from '../../../types'
import { PlaygroundMessageJump } from '../playground-message-jump'

function message(index: number, from: Message['from'] = 'user'): Message {
  return {
    key: `message-${index}`,
    from,
    versions: [{ id: `version-${index}`, content: `Message ${index}` }],
  }
}

const manyMessages = Array.from({ length: 100 }, (_, index) =>
  message(index, index % 2 === 0 ? 'user' : 'assistant')
)

test('the jump window keeps the spacer proportional and clamps the tail', () => {
  expect(messageJumpWindow(1000, 6400, 320)).toEqual({
    start: 97,
    end: 108,
    offset: 6208,
    totalHeight: 64000,
  })
  expect(messageJumpWindow(3, 0, 320)).toEqual({
    start: 0,
    end: 3,
    offset: 0,
    totalHeight: 192,
  })
  expect(messageJumpWindow(100, 6368, 320)).toEqual({
    start: 95,
    end: 100,
    offset: 6080,
    totalHeight: 6400,
  })
})

test('long conversations mount only the rows around the viewport', () => {
  render(
    <PlaygroundMessageJump
      messages={manyMessages}
      onOpenChange={vi.fn()}
      onSelect={vi.fn()}
      open
    />
  )

  const rows = screen.getAllByRole('option')
  expect(rows).toHaveLength(11)
  expect(rows[0]).toHaveTextContent('#1')
  expect(screen.queryByText('#100')).not.toBeInTheDocument()
})

test('searching narrows the index and enter jumps to the message', async () => {
  const onSelect = vi.fn()
  render(
    <PlaygroundMessageJump
      messages={manyMessages}
      onOpenChange={vi.fn()}
      onSelect={onSelect}
      open
    />
  )

  await userEvent.type(
    screen.getByRole('textbox', {
      name: 'Search messages in this conversation.',
    }),
    'Message 42'
  )
  expect(screen.getAllByRole('option')).toHaveLength(1)

  await userEvent.keyboard('{Enter}')

  expect(onSelect).toHaveBeenCalledWith('message-42')
})

test('typing a new search returns the jump list to the top', async () => {
  render(
    <PlaygroundMessageJump
      messages={manyMessages}
      onOpenChange={vi.fn()}
      onSelect={vi.fn()}
      open
    />
  )

  const list = screen.getByRole('listbox', { name: 'Jump to message' })
  list.scrollTop = 640
  fireEvent.scroll(list)

  await userEvent.type(
    screen.getByRole('textbox', {
      name: 'Search messages in this conversation.',
    }),
    'Message'
  )

  expect(list.scrollTop).toBe(0)
})

test('an empty conversation explains why there is nothing to jump to', () => {
  render(
    <PlaygroundMessageJump
      messages={[]}
      onOpenChange={vi.fn()}
      onSelect={vi.fn()}
      open
    />
  )

  expect(
    screen.getByText('This conversation has no messages yet.')
  ).toBeVisible()
})
