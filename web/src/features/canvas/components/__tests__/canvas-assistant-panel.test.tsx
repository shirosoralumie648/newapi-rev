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

import type { ModelOption } from '@/features/playground/types'

import { CANVAS_ASSISTANT_MESSAGES } from '../../constants'
import type { CanvasAssistantMessage } from '../../hooks/use-canvas-assistant'
import { CanvasAssistantPanel } from '../canvas-assistant-panel'

const MODELS: ModelOption[] = [
  { label: 'Model one', value: 'm1' },
  { label: 'Model two', value: 'm2' },
]

const ASSISTANT_REPLY: CanvasAssistantMessage = {
  id: 'reply-1',
  role: 'assistant',
  content: 'Here is a draft.',
  status: 'done',
}

function panelProps(
  overrides: Partial<Parameters<typeof CanvasAssistantPanel>[0]> = {}
): Parameters<typeof CanvasAssistantPanel>[0] {
  return {
    anchorLabel: 'Text',
    canGenerate: true,
    contextCount: 2,
    disabled: false,
    messages: [],
    mode: 'chat',
    model: 'm1',
    models: MODELS,
    onGenerate: vi.fn(),
    onInsertReply: vi.fn(),
    onModeChange: vi.fn(),
    onModelChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    streaming: false,
    workflowPhase: 'idle',
    ...overrides,
  }
}

test('shows the empty state and the anchor context', () => {
  render(<CanvasAssistantPanel {...panelProps()} />)

  expect(screen.getByText('Canvas assistant')).toBeInTheDocument()
  expect(
    screen.getByText('Selected node: Text · 2 nodes in context')
  ).toBeInTheDocument()
})

test('falls back to the whole canvas and hints at the missing selection', () => {
  render(
    <CanvasAssistantPanel
      {...panelProps({ anchorLabel: null, canGenerate: false, mode: 'image' })}
    />
  )

  expect(
    screen.getByText('Whole canvas · 2 nodes in context')
  ).toBeInTheDocument()
  expect(
    screen.getByText(CANVAS_ASSISTANT_MESSAGES.ANCHOR_REQUIRED)
  ).toBeInTheDocument()
})

test('reports mode and model changes', async () => {
  const user = userEvent.setup()
  const props = panelProps()
  render(<CanvasAssistantPanel {...props} />)

  await user.selectOptions(screen.getByLabelText('Assistant mode'), 'image')
  expect(props.onModeChange).toHaveBeenCalledWith('image')

  await user.selectOptions(screen.getByLabelText('Model'), 'm2')
  expect(props.onModelChange).toHaveBeenCalledWith('m2')
})

test('sends the draft with the button and ignores the send key on Shift+Enter', async () => {
  const user = userEvent.setup()
  const props = panelProps()
  render(<CanvasAssistantPanel {...props} />)

  const composer = screen.getByRole('textbox', { name: 'Ask the assistant' })
  const send = screen.getByRole('button', { name: 'Send' })
  expect(send).toBeDisabled()

  await user.type(composer, 'hello')
  await user.click(send)
  expect(props.onSend).toHaveBeenCalledWith('hello')
  expect(composer).toHaveValue('')

  await user.type(composer, 'world{Shift>}{Enter}{/Shift}')
  expect(props.onSend).toHaveBeenCalledTimes(1)

  await user.type(composer, '{Enter}')
  expect(props.onSend).toHaveBeenLastCalledWith('world')
})

test('offers stop while a reply streams and disables the composer', async () => {
  const user = userEvent.setup()
  const props = panelProps({
    messages: [
      { id: 'stream-1', role: 'assistant', content: '', status: 'streaming' },
    ],
    streaming: true,
  })
  render(<CanvasAssistantPanel {...props} />)

  expect(screen.getByText('Responding...')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  expect(
    screen.getByRole('textbox', { name: 'Ask the assistant' })
  ).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Stop' }))
  expect(props.onStop).toHaveBeenCalledTimes(1)
})

test('shows the settled reply and inserts it in the chat mode', async () => {
  const user = userEvent.setup()
  const props = panelProps({ messages: [ASSISTANT_REPLY] })
  render(<CanvasAssistantPanel {...props} />)

  expect(screen.getByText('Here is a draft.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Insert into canvas' }))
  expect(props.onInsertReply).toHaveBeenCalledWith(ASSISTANT_REPLY)
})

test('turns the reply into a generation in the image mode', async () => {
  const user = userEvent.setup()
  const props = panelProps({ messages: [ASSISTANT_REPLY], mode: 'image' })
  render(<CanvasAssistantPanel {...props} />)

  await user.click(screen.getByRole('button', { name: 'Generate image' }))
  expect(props.onGenerate).toHaveBeenCalledWith(ASSISTANT_REPLY)
})

test('disables generation while a run is active', () => {
  render(
    <CanvasAssistantPanel
      {...panelProps({
        messages: [ASSISTANT_REPLY],
        mode: 'video',
        workflowPhase: 'running',
      })}
    />
  )

  expect(screen.getByRole('button', { name: 'Generate video' })).toBeDisabled()
})

test('shows the failure text and offers no action on a failed reply', () => {
  const { rerender } = render(
    <CanvasAssistantPanel
      {...panelProps({
        messages: [
          {
            id: 'failed-1',
            role: 'assistant',
            content: '',
            status: 'error',
            error: 'Upstream timeout',
          },
        ],
      })}
    />
  )

  expect(screen.getByText('Upstream timeout')).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Insert into canvas' })
  ).toBeNull()

  rerender(
    <CanvasAssistantPanel
      {...panelProps({
        messages: [
          { id: 'failed-2', role: 'assistant', content: '', status: 'error' },
        ],
      })}
    />
  )
  expect(
    screen.getByText(CANVAS_ASSISTANT_MESSAGES.REQUEST_FAILED)
  ).toBeInTheDocument()
})

test('disables the composer without a model or on a read-only canvas', () => {
  const { rerender } = render(
    <CanvasAssistantPanel {...panelProps({ model: '', models: [] })} />
  )

  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  expect(screen.getByText('No models available')).toBeInTheDocument()

  rerender(<CanvasAssistantPanel {...panelProps({ disabled: true })} />)
  expect(
    screen.getByRole('textbox', { name: 'Ask the assistant' })
  ).toBeDisabled()
})
