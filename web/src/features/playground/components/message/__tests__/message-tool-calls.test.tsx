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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { Message, MessageToolCall } from '../../../types'
import { MessageToolCalls } from '../message-tool-calls'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const pendingCall: MessageToolCall = {
  id: 'call_weather',
  name: 'get_weather',
  arguments: '{"city":"Paris"}',
  status: 'pending',
}

type RenderOptions = {
  toolCalls: MessageToolCall[]
  isLastMessage?: boolean
  onContinue?: (message: Message) => void
  onDeny?: (message: Message, toolCallId: string) => void
  onProvideResult?: (
    message: Message,
    toolCallId: string,
    result: string
  ) => void
}

function renderToolCalls(options: RenderOptions) {
  const message: Message = {
    key: 'assistant-1',
    from: 'assistant',
    status: 'complete',
    isContentComplete: true,
    versions: [{ id: 'a1', content: '', toolCalls: options.toolCalls }],
  }

  const view = render(
    <MessageToolCalls
      isGenerating={false}
      isLastMessage={options.isLastMessage ?? true}
      message={message}
      onContinue={options.onContinue}
      onDeny={options.onDeny}
      onProvideResult={options.onProvideResult}
      version={message.versions[0]}
    />
  )

  return { message, ...view }
}

test('a pending call shows the approval actions and reports a denial', async () => {
  const user = userEvent.setup()
  const onDeny = vi.fn()
  const { message } = renderToolCalls({ toolCalls: [pendingCall], onDeny })

  expect(screen.getByText('Awaiting Approval')).toBeVisible()
  expect(
    screen.getByText('This tool call is waiting for a result.')
  ).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Deny' }))

  expect(onDeny).toHaveBeenCalledWith(message, 'call_weather')
})

test('providing a result sends the pasted text through the callback', async () => {
  const user = userEvent.setup()
  const onProvideResult = vi.fn()
  const { message } = renderToolCalls({
    toolCalls: [pendingCall],
    onProvideResult,
  })

  await user.click(screen.getByRole('button', { name: 'Provide result' }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Tool result'), 'Sunny, 21 C')
  await user.click(
    within(dialog).getByRole('button', { name: 'Provide result' })
  )

  expect(onProvideResult).toHaveBeenCalledWith(
    message,
    'call_weather',
    'Sunny, 21 C'
  )
})

test('a denied call hides the approval actions and shows the rejection', async () => {
  const user = userEvent.setup()
  renderToolCalls({ toolCalls: [{ ...pendingCall, status: 'denied' }] })

  expect(screen.getByText('Denied')).toBeVisible()
  await user.click(screen.getByRole('button', { name: /get_weather/ }))

  expect(await screen.findByText('Tool call denied')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Provide result' })).toBeNull()
})

test('a completed call shows that a result was provided', async () => {
  const user = userEvent.setup()
  renderToolCalls({
    toolCalls: [{ ...pendingCall, status: 'completed', result: 'Sunny' }],
  })

  expect(screen.getByText('Completed')).toBeVisible()
  await user.click(screen.getByRole('button', { name: /get_weather/ }))

  expect(await screen.findByText('Result provided')).toBeVisible()
})

test('continue generation appears for the last answered reply only', async () => {
  const user = userEvent.setup()
  const answered: MessageToolCall = {
    ...pendingCall,
    status: 'completed',
    result: 'Sunny',
  }

  const older = renderToolCalls({ toolCalls: [answered], isLastMessage: false })
  expect(
    screen.queryByRole('button', { name: 'Continue generation' })
  ).toBeNull()
  older.unmount()

  const onContinue = vi.fn()
  const { message } = renderToolCalls({ toolCalls: [answered], onContinue })
  await user.click(screen.getByRole('button', { name: 'Continue generation' }))

  expect(onContinue).toHaveBeenCalledWith(message)
})
