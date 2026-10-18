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
import i18next from 'i18next'
import { beforeAll, describe, expect, test, vi } from 'vitest'

import type { Message } from '../../../types'
import { PlaygroundParallelCompare } from '../playground-parallel-compare'

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    'Comparing {{count}} models': 'Comparing {{count}} models',
    'In use': 'In use',
    'Reply from {{model}}': 'Reply from {{model}}',
    'Responding...': 'Responding...',
    'Retry this reply': 'Retry this reply',
    'Select one reply to continue the conversation':
      'Select one reply to continue the conversation',
    'Use this reply': 'Use this reply',
  })
})

function comparisonMessage(overrides: Partial<Message> = {}): Message {
  return {
    key: 'group-1',
    from: 'assistant',
    parallel: true,
    status: 'complete',
    isContentComplete: true,
    activeVersionIndex: 0,
    versions: [
      {
        id: 'v1',
        content: 'Answer from GPT',
        model: 'gpt-4o',
        status: 'complete',
      },
      {
        id: 'v2',
        content: 'Answer from Claude',
        model: 'claude-3',
        status: 'complete',
      },
    ],
    ...overrides,
  }
}

describe('PlaygroundParallelCompare', () => {
  test('renders one labelled card per compared model and marks the reply in use', () => {
    render(<PlaygroundParallelCompare message={comparisonMessage()} />)

    expect(
      screen.getByRole('group', { name: 'Comparing 2 models' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('Select one reply to continue the conversation')
    ).toBeInTheDocument()

    const active = screen.getByRole('region', { name: 'Reply from gpt-4o' })
    expect(within(active).getByText('Answer from GPT')).toBeInTheDocument()
    expect(within(active).getByText('In use')).toBeInTheDocument()

    const other = screen.getByRole('region', { name: 'Reply from claude-3' })
    expect(within(other).getByText('Answer from Claude')).toBeInTheDocument()
    expect(within(other).queryByText('In use')).not.toBeInTheDocument()
  })

  test('choosing a reply reports the version index that should continue the conversation', async () => {
    const user = userEvent.setup()
    const onSelectVersion = vi.fn()
    const message = comparisonMessage()

    render(
      <PlaygroundParallelCompare
        message={message}
        onSelectVersion={onSelectVersion}
      />
    )

    const other = screen.getByRole('region', { name: 'Reply from claude-3' })
    await user.click(
      within(other).getByRole('button', { name: 'Use this reply' })
    )

    expect(onSelectVersion).toHaveBeenCalledWith(message, 1)
  })

  test('a reply still in flight shows a loader instead of content or a choose action', () => {
    const message = comparisonMessage({
      versions: [
        {
          id: 'v1',
          content: 'Answer from GPT',
          model: 'gpt-4o',
          status: 'complete',
        },
        {
          id: 'v2',
          content: '',
          model: 'claude-3',
          status: 'loading',
        },
      ],
    })

    render(<PlaygroundParallelCompare message={message} />)

    const pending = screen.getByRole('region', { name: 'Reply from claude-3' })
    expect(within(pending).getByText('Responding...')).toBeInTheDocument()
    expect(
      within(pending).queryByRole('button', { name: 'Use this reply' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Answer from GPT')).toBeInTheDocument()
  })

  test('a failed reply shows its error and retries only that version', async () => {
    const user = userEvent.setup()
    const onRetryVersion = vi.fn()
    const message = comparisonMessage({
      activeVersionIndex: 1,
      versions: [
        {
          id: 'v1',
          content: 'Answer from GPT',
          model: 'gpt-4o',
          status: 'complete',
        },
        {
          id: 'v2',
          content: 'Request error occurred: Upstream refused',
          model: 'claude-3',
          status: 'error',
          errorCode: null,
        },
      ],
    })

    render(
      <PlaygroundParallelCompare
        message={message}
        onRetryVersion={onRetryVersion}
      />
    )

    const failed = screen.getByRole('region', { name: 'Reply from claude-3' })
    expect(within(failed).getByText(/Upstream refused/)).toBeInTheDocument()
    expect(within(failed).queryByText('In use')).not.toBeInTheDocument()

    await user.click(
      within(failed).getByRole('button', { name: 'Retry this reply' })
    )

    expect(onRetryVersion).toHaveBeenCalledWith(message, 1)
  })
})
