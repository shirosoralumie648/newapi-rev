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

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
} from '../../../constants'
import type { Message, PlaygroundSession } from '../../../types'
import { PlaygroundMessageSearch } from '../playground-message-search'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

function message(key: string, from: Message['from'], content: string): Message {
  return {
    key,
    from,
    status: 'complete',
    versions: [{ id: `${key}-v`, content }],
  }
}

function session(
  id: string,
  title: string,
  updatedAt: number,
  messages: Message[]
): PlaygroundSession {
  return {
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    config: { ...DEFAULT_CONFIG },
    parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
    systemPrompt: '',
    openingMessage: '',
    suggestedQuestions: [],
    context: { ...DEFAULT_CONTEXT_SETTINGS },
    contextSummary: null,
    messages,
  }
}

const sessions = [
  session('older', 'Older conversation', 1, [
    message('m1', 'user', 'The release checklist lives here'),
  ]),
  session('newer', 'Newest conversation', 2, [
    message('m2', 'assistant', 'Notes about the Release'),
  ]),
]

test('searches every hydrated conversation and jumps to the chosen hit', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const onOpenChange = vi.fn()

  render(
    <PlaygroundMessageSearch
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      open
      sessions={sessions}
    />
  )

  await user.type(
    screen.getByRole('textbox', { name: 'Search messages' }),
    'release'
  )

  expect(
    screen.getByText('Newest conversation · Assistant')
  ).toBeInTheDocument()
  expect(screen.getByText('Older conversation · User')).toBeInTheDocument()
  expect(screen.getByText('Release')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /Newest conversation/ }))

  expect(onSelect).toHaveBeenCalledWith('newer', 'm2')
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('labels results as incomplete while the workspace is still hydrating', () => {
  render(
    <PlaygroundMessageSearch
      isHydrating
      onOpenChange={vi.fn()}
      onSelect={vi.fn()}
      open
      sessions={sessions}
    />
  )

  expect(screen.getByRole('status')).toHaveTextContent(
    'Some conversations are still loading. Results may be incomplete.'
  )
})

test('reports an empty result without treating a blank query as no matches', async () => {
  const user = userEvent.setup()

  render(
    <PlaygroundMessageSearch
      onOpenChange={vi.fn()}
      onSelect={vi.fn()}
      open
      sessions={sessions}
    />
  )

  expect(screen.queryByText('No matching messages.')).not.toBeInTheDocument()

  await user.type(
    screen.getByRole('textbox', { name: 'Search messages' }),
    'zebra'
  )

  expect(screen.getByText('No matching messages.')).toBeInTheDocument()
})
