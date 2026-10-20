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
    'A better': 'A better',
    'Add a one-sentence note (optional)': 'Add a one-sentence note (optional)',
    'Anonymous comparison': 'Anonymous comparison',
    'B better': 'B better',
    'Both bad': 'Both bad',
    Channel: 'Channel',
    'Comparing {{count}} models': 'Comparing {{count}} models',
    'From the settled consume log': 'From the settled consume log',
    'Group ratio': 'Group ratio',
    'In use': 'In use',
    'Instance votes': 'Instance votes',
    'Model A': 'Model A',
    'Model B': 'Model B',
    'No votes yet.': 'No votes yet.',
    Notes: 'Notes',
    'Preference vote': 'Preference vote',
    'Reply from {{model}}': 'Reply from {{model}}',
    'Request diagnostics': 'Request diagnostics',
    'Responding...': 'Responding...',
    'Retry this reply': 'Retry this reply',
    'Save note': 'Save note',
    'Select one reply to continue the conversation':
      'Select one reply to continue the conversation',
    'Settled quota': 'Settled quota',
    Tie: 'Tie',
    'Total votes: {{count}}': 'Total votes: {{count}}',
    'Use this reply': 'Use this reply',
    'Vote note': 'Vote note',
    'Vote on this comparison': 'Vote on this comparison',
    'Vote summary': 'Vote summary',
    'Which reply is better?': 'Which reply is better?',
    'Your votes': 'Your votes',
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

function anonymousMessage(overrides: Partial<Message> = {}): Message {
  return comparisonMessage({
    anonymous: true,
    versions: [
      {
        id: 'v1',
        content: 'GPT-4O answered first.',
        model: 'gpt-4o',
        status: 'complete',
      },
      {
        id: 'v2',
        content: 'Request failed for gpt-4.',
        model: 'gpt-4',
        status: 'complete',
      },
    ],
    ...overrides,
  })
}

describe('PlaygroundParallelCompare anonymous arena', () => {
  test('replaces model names with A/B labels and never renders the real names', () => {
    render(
      <PlaygroundParallelCompare
        message={anonymousMessage()}
        onArenaVote={vi.fn()}
      />
    )

    expect(
      screen.getByRole('group', { name: 'Anonymous comparison' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Comparing 2 models' })
    ).not.toBeInTheDocument()

    const first = screen.getByRole('region', { name: 'Reply from Model A' })
    const second = screen.getByRole('region', { name: 'Reply from Model B' })
    expect(
      within(first).getByText('Model A answered first.')
    ).toBeInTheDocument()
    expect(
      within(second).getByText('Request failed for Model B.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/gpt-4o/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/gpt-4/i)).not.toBeInTheDocument()
  })

  test('redacts real model names from a failed anonymous reply', () => {
    const message = anonymousMessage({
      status: 'error',
      versions: [
        {
          id: 'v1',
          content: 'Request failed for gpt-4o.',
          model: 'gpt-4o',
          status: 'error',
          errorCode: null,
        },
        {
          id: 'v2',
          content: 'gpt-4 also failed.',
          model: 'gpt-4',
          status: 'error',
          errorCode: null,
        },
      ],
    })

    render(
      <PlaygroundParallelCompare message={message} onArenaVote={vi.fn()} />
    )

    const first = screen.getByRole('region', { name: 'Reply from Model A' })
    const second = screen.getByRole('region', { name: 'Reply from Model B' })
    expect(
      within(first).getByText(/Request failed for Model A/)
    ).toBeInTheDocument()
    expect(within(second).getByText(/Model B also failed/)).toBeInTheDocument()
    expect(screen.queryByText(/gpt-4o/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/gpt-4/i)).not.toBeInTheDocument()
  })

  test('hides the serving channel from anonymous diagnostics', async () => {
    const user = userEvent.setup()
    const message = anonymousMessage()
    message.versions[0] = { ...message.versions[0], requestId: 'req-a' }

    render(
      <PlaygroundParallelCompare
        costs={
          new Map([
            [
              'req-a',
              {
                requestId: 'req-a',
                quota: 1234,
                promptTokens: 10,
                completionTokens: 20,
                totalTokens: 30,
                modelName: 'gpt-4o',
                createdAt: 0,
                channelKey: '#4821',
                channelName: 'Secret relay',
                groupRatio: 2,
              },
            ],
          ])
        }
        message={message}
        onArenaVote={vi.fn()}
      />
    )

    await user.hover(screen.getByText('Request diagnostics'))

    expect(await screen.findByText('Group ratio')).toBeVisible()
    expect(screen.queryByText('Channel')).not.toBeInTheDocument()
    expect(screen.queryByText('Secret relay · #4821')).not.toBeInTheDocument()
    expect(screen.queryByText(/#4821/)).not.toBeInTheDocument()
  })

  test('offers the four raw choices and stores the optional note with the vote', async () => {
    const user = userEvent.setup()
    const onArenaVote = vi.fn().mockResolvedValue(undefined)

    render(
      <PlaygroundParallelCompare
        message={anonymousMessage()}
        onArenaVote={onArenaVote}
        arenaVote={{
          id: 1,
          messageKey: 'group-1',
          choice: 'a',
          note: 'First impression',
          createdAt: 1,
          updatedAt: 2,
        }}
      />
    )

    const votes = screen.getByRole('group', {
      name: 'Vote on this comparison',
    })
    for (const label of ['A better', 'B better', 'Tie', 'Both bad']) {
      expect(within(votes).getByRole('button', { name: label })).toBeEnabled()
    }
    expect(
      within(votes).getByRole('button', { name: 'A better' })
    ).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(votes).getByRole('button', { name: 'B better' }))
    expect(onArenaVote).toHaveBeenCalledWith('group-1', 'b', 'First impression')

    const note = screen.getByRole('textbox', { name: 'Vote note' })
    await user.clear(note)
    await user.type(note, 'Second look')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    expect(onArenaVote).toHaveBeenLastCalledWith('group-1', 'a', 'Second look')
  })

  test('shows personal totals and adds the instance scope for administrators', async () => {
    const user = userEvent.setup()

    render(
      <PlaygroundParallelCompare
        message={anonymousMessage()}
        onArenaVote={vi.fn()}
        arenaPersonalSummary={{
          scope: 'personal',
          total: 3,
          choices: { a: 1, b: 1, tie: 1, bothBad: 0 },
          notes: 1,
        }}
        arenaInstanceSummary={{
          scope: 'instance',
          total: 8,
          choices: { a: 3, b: 2, tie: 2, bothBad: 1 },
          notes: 4,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Vote summary' }))
    expect(screen.getByText('Total votes: 3')).toBeInTheDocument()
    expect(screen.getByText('Your votes')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Instance votes' }))
    expect(screen.getByText('Total votes: 8')).toBeInTheDocument()
  })

  test('hides the vote bar without a vote callback and disables it while generating', () => {
    const { rerender } = render(
      <PlaygroundParallelCompare message={anonymousMessage()} />
    )
    expect(
      screen.queryByRole('group', { name: 'Vote on this comparison' })
    ).not.toBeInTheDocument()

    rerender(
      <PlaygroundParallelCompare
        isGenerating
        message={anonymousMessage()}
        onArenaVote={vi.fn()}
      />
    )
    const votes = screen.getByRole('group', {
      name: 'Vote on this comparison',
    })
    for (const label of ['A better', 'B better', 'Tie', 'Both bad']) {
      expect(within(votes).getByRole('button', { name: label })).toBeDisabled()
    }
  })
})
