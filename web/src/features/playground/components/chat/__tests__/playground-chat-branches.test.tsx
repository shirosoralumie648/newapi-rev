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
import i18next from 'i18next'
import { beforeAll, describe, expect, test, vi } from 'vitest'

import type { Message, PlaygroundContextSummary } from '../../../types'
import { PlaygroundChat } from '../playground-chat'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    'Compressed {{messages}} earlier messages':
      'Compressed {{messages}} earlier messages',
    'Comparing {{count}} models': 'Comparing {{count}} models',
    'Reply from {{model}}': 'Reply from {{model}}',
  })
})

const branchedMessage: Message = {
  key: 'assistant-1',
  from: 'assistant',
  status: 'complete',
  isContentComplete: true,
  activeVersionIndex: 1,
  versions: [
    { id: 'a1', content: 'Original answer' },
    { id: 'a2', content: 'Regenerated answer' },
  ],
}

describe('PlaygroundChat branch history', () => {
  test('renders the branch selector for a message with multiple versions', () => {
    render(<PlaygroundChat messages={[branchedMessage]} />)

    expect(screen.getByText('Regenerated answer')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  test('renders the comparison view for a parallel message group', async () => {
    const user = userEvent.setup()
    const onSelectVersion = vi.fn()
    const group: Message = {
      key: 'parallel-1',
      from: 'assistant',
      parallel: true,
      status: 'complete',
      isContentComplete: true,
      activeVersionIndex: 0,
      versions: [
        {
          id: 'p1',
          content: 'First compared answer',
          model: 'gpt-4o',
          status: 'complete',
        },
        {
          id: 'p2',
          content: 'Second compared answer',
          model: 'claude-3',
          status: 'complete',
        },
      ],
    }

    render(
      <PlaygroundChat messages={[group]} onSelectVersion={onSelectVersion} />
    )

    expect(
      screen.getByRole('group', { name: 'Comparing 2 models' })
    ).toBeInTheDocument()
    expect(screen.getByText('First compared answer')).toBeInTheDocument()
    expect(screen.getByText('Second compared answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Previous branch' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Use this reply' }))

    expect(onSelectVersion).toHaveBeenCalledWith(group, 1)
  })

  test('switching branches reports the selected version index', async () => {
    const user = userEvent.setup()
    const onSelectVersion = vi.fn()

    render(
      <PlaygroundChat
        messages={[branchedMessage]}
        onSelectVersion={onSelectVersion}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Previous branch' }))

    expect(onSelectVersion).toHaveBeenCalledWith(branchedMessage, 0)
  })

  test('hides the branch selector for a single-version message', () => {
    render(
      <PlaygroundChat
        messages={[
          {
            key: 'assistant-2',
            from: 'assistant',
            status: 'complete',
            versions: [{ id: 'b1', content: 'Only answer' }],
          },
        ]}
      />
    )

    expect(screen.getByText('Only answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Previous branch' })
    ).not.toBeInTheDocument()
  })

  test('shows a preset opening message and sends its suggested questions', async () => {
    const user = userEvent.setup()
    const onSelectPrompt = vi.fn()

    render(
      <PlaygroundChat
        messages={[]}
        onSelectPrompt={onSelectPrompt}
        openingMessage='Welcome to the code review.'
        suggestedQuestions={['Explain this diff', 'Find bugs']}
      />
    )

    expect(screen.getByText('Welcome to the code review.')).toBeInTheDocument()
    expect(screen.getByText('Suggested questions')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Analyze data' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Find bugs' }))
    expect(onSelectPrompt).toHaveBeenCalledWith('Find bugs')
  })

  test('renders the compression node right after the messages it covers', () => {
    const messages: Message[] = [
      {
        key: 'u1',
        from: 'user',
        versions: [{ id: 'u1-v', content: 'First question' }],
      },
      {
        key: 'a1',
        from: 'assistant',
        status: 'complete',
        versions: [{ id: 'a1-v', content: 'First answer' }],
      },
      {
        key: 'u2',
        from: 'user',
        versions: [{ id: 'u2-v', content: 'Second question' }],
      },
    ]
    const summary: PlaygroundContextSummary = {
      id: 'pgc_1',
      content: 'Summary of the first exchange.',
      throughMessageKey: 'a1',
      messageCount: 2,
      model: 'summary-model',
      createdAt: 1,
    }

    render(<PlaygroundChat contextSummary={summary} messages={messages} />)

    const node = screen.getByRole('button', {
      name: 'Compressed 2 earlier messages',
    })
    const answer = screen.getByText('First answer')
    const question = screen.getByText('Second question')
    expect(
      answer.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      node.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
