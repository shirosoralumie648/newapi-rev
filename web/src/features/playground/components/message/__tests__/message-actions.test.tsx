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

import type { Message } from '../../../types'
import { MessageActions } from '../message-actions'

const message: Message = {
  key: 'm1',
  from: 'user',
  status: 'complete',
  versions: [{ id: 'v1', content: 'Hello canvas' }],
}

test('the send-to-canvas action reports the message it was used on', async () => {
  const user = userEvent.setup()
  const onSendToCanvas = vi.fn()

  render(<MessageActions message={message} onSendToCanvas={onSendToCanvas} />)
  await user.click(screen.getByRole('button', { name: 'Send to canvas' }))

  expect(onSendToCanvas).toHaveBeenCalledWith(message)
})

test('the send-to-canvas action is hidden without a handler', () => {
  render(<MessageActions message={message} />)

  expect(
    screen.queryByRole('button', { name: 'Send to canvas' })
  ).not.toBeInTheDocument()
})

test('the read-aloud action reports the message it was used on', async () => {
  const user = userEvent.setup()
  const onReadAloud = vi.fn()

  render(<MessageActions message={message} onReadAloud={onReadAloud} />)
  await user.click(screen.getByRole('button', { name: 'Read aloud' }))

  expect(onReadAloud).toHaveBeenCalledWith(message)
})

test('the read-aloud action is hidden without a handler', () => {
  render(<MessageActions message={message} />)

  expect(
    screen.queryByRole('button', { name: 'Read aloud' })
  ).not.toBeInTheDocument()
})

test('the continue action reports the truncated assistant reply it continues', async () => {
  const user = userEvent.setup()
  const onContinue = vi.fn()
  const truncated: Message = {
    key: 'a1',
    from: 'assistant',
    status: 'complete',
    versions: [{ id: 'v1', content: 'Half an answer', finishReason: 'length' }],
  }

  render(
    <MessageActions canContinue message={truncated} onContinue={onContinue} />
  )
  await user.click(screen.getByRole('button', { name: 'Continue generation' }))

  expect(onContinue).toHaveBeenCalledWith(truncated)
})

test('the continue action is hidden without a continuable reply', () => {
  render(<MessageActions message={message} onContinue={() => undefined} />)

  expect(
    screen.queryByRole('button', { name: 'Continue generation' })
  ).not.toBeInTheDocument()
})
