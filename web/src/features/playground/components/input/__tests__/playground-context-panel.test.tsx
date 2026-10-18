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
import type { ComponentProps } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'

import { PromptInputProvider } from '@/components/ai-elements/prompt-input'

import { DEFAULT_CONTEXT_SETTINGS } from '../../../constants'
import { planPlaygroundContext } from '../../../lib'
import {
  clearPlaygroundAttachmentCache,
  primePlaygroundAttachment,
} from '../../../lib/attachment-store'
import type { Message, PlaygroundContextSummary } from '../../../types'
import { PlaygroundContextPanel } from '../playground-context-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const history: Message[] = [
  { key: 'm1', from: 'user', versions: [{ id: 'v1', content: 'first' }] },
  { key: 'm2', from: 'assistant', versions: [{ id: 'v2', content: 'second' }] },
  { key: 'm3', from: 'user', versions: [{ id: 'v3', content: 'third' }] },
]

const compressionNode: PlaygroundContextSummary = {
  id: 'pgc_1',
  content: 'Earlier messages were compressed.',
  throughMessageKey: 'm1',
  messageCount: 1,
  model: 'summary-model',
  createdAt: 1,
}

function mount(
  overrides: Partial<ComponentProps<typeof PlaygroundContextPanel>> = {}
) {
  const settings = { ...DEFAULT_CONTEXT_SETTINGS, historyLimit: 1 }
  const props: ComponentProps<typeof PlaygroundContextPanel> = {
    settings,
    summary: null,
    plan: planPlaygroundContext({ messages: history, settings }),
    models: [
      { label: 'gpt-4o', value: 'gpt-4o' },
      { label: 'summary-model', value: 'summary-model' },
    ],
    currentModel: 'gpt-4o',
    onSettingsChange: vi.fn(),
    onRemoveSummary: vi.fn(),
    onSummarizeNow: vi.fn(),
    ...overrides,
  }
  render(
    <PromptInputProvider>
      <PlaygroundContextPanel {...props} />
    </PromptInputProvider>
  )
  return props
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Context management' }))
}

afterEach(() => {
  clearPlaygroundAttachmentCache()
})

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    'Context management': 'Context management',
    'Context to send: {{messages}} messages · ~{{tokens}} tokens (estimated)':
      'Context to send: {{messages}} messages · ~{{tokens}} tokens (estimated)',
    '{{messages}} older messages are left out of the next request (~{{tokens}} tokens).':
      '{{messages}} older messages are left out of the next request (~{{tokens}} tokens).',
    '{{images}} images from earlier messages are left out of the next request.':
      '{{images}} images from earlier messages are left out of the next request.',
    'The next send summarizes {{messages}} older messages (~{{tokens}} tokens).':
      'The next send summarizes {{messages}} older messages (~{{tokens}} tokens).',
    'Summarize automatically': 'Summarize automatically',
    'History message limit': 'History message limit',
    'Token budget': 'Token budget',
    'Summary model': 'Summary model',
    'Compressed {{messages}} earlier messages':
      'Compressed {{messages}} earlier messages',
    'Remove summary': 'Remove summary',
    'Show summary': 'Show summary',
    'Hide summary': 'Hide summary',
    'Summarize now': 'Summarize now',
  })
})

test('shows the size of the next send and the messages a limit leaves out', async () => {
  const user = userEvent.setup()
  mount()
  await openPanel(user)

  expect(
    await screen.findByText(
      'Context to send: 1 messages · ~2 tokens (estimated)'
    )
  ).toBeInTheDocument()
  expect(
    screen.getByText(
      '2 older messages are left out of the next request (~4 tokens).'
    )
  ).toBeInTheDocument()
})

test('an automatic summary marks the dropped messages as summarized', async () => {
  const user = userEvent.setup()
  const settings = {
    ...DEFAULT_CONTEXT_SETTINGS,
    historyLimit: 1,
    autoSummarize: true,
  }
  mount({
    settings,
    plan: planPlaygroundContext({ messages: history, settings }),
  })
  await openPanel(user)

  expect(
    await screen.findByText(
      'The next send summarizes 2 older messages (~4 tokens).'
    )
  ).toBeInTheDocument()
})

test('a text-only model reports history images left out of the next request', async () => {
  const user = userEvent.setup()
  // A send caches the attachment bytes before the plan is built
  // (ensurePlaygroundMessageAttachments), so the request carries the image
  // part the policy then has to replace.
  primePlaygroundAttachment('a1', 'data:image/png;base64,iVBORw0KGgo=')
  const messages: Message[] = [
    {
      key: 'm1',
      from: 'user',
      versions: [
        {
          id: 'v1',
          content: 'look',
          attachments: [{ id: 'a1', url: '', mediaType: 'image/png' }],
        },
      ],
    },
    {
      key: 'm2',
      from: 'assistant',
      versions: [{ id: 'v2', content: 'seen' }],
    },
    {
      key: 'm3',
      from: 'user',
      versions: [{ id: 'v3', content: 'next' }],
    },
  ]
  mount({
    settings: { ...DEFAULT_CONTEXT_SETTINGS },
    plan: planPlaygroundContext({
      messages,
      settings: { ...DEFAULT_CONTEXT_SETTINGS },
      model: 'deepseek-chat',
    }),
  })
  await openPanel(user)

  expect(
    await screen.findByText(
      '1 images from earlier messages are left out of the next request.'
    )
  ).toBeInTheDocument()
})

test('editing the limits reports the parsed settings', async () => {
  const user = userEvent.setup()
  const props = mount({ settings: { ...DEFAULT_CONTEXT_SETTINGS } })
  await openPanel(user)

  const historyLimit = await screen.findByLabelText('History message limit')
  await user.type(historyLimit, '7')
  expect(props.onSettingsChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ historyLimit: 7 })
  )

  const tokenBudget = screen.getByLabelText('Token budget')
  await user.type(tokenBudget, '3')
  expect(props.onSettingsChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ tokenBudget: 3 })
  )
})

test('toggling automatic summarization reports the change', async () => {
  const user = userEvent.setup()
  const props = mount()
  await openPanel(user)

  const toggle = await screen.findByRole('switch', {
    name: 'Summarize automatically',
  })
  await user.click(toggle)

  expect(props.onSettingsChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ autoSummarize: true })
  )
})

test('the compression node expands to its text and can be removed', async () => {
  const user = userEvent.setup()
  const props = mount({
    summary: compressionNode,
    plan: planPlaygroundContext({
      messages: history,
      settings: { ...DEFAULT_CONTEXT_SETTINGS, historyLimit: 1 },
      summary: compressionNode,
    }),
  })
  await openPanel(user)

  expect(
    await screen.findByText('Compressed 1 earlier messages')
  ).toBeInTheDocument()
  expect(
    screen.queryByText('Earlier messages were compressed.')
  ).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Show summary' }))
  expect(
    await screen.findByText('Earlier messages were compressed.')
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Hide summary' })
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Remove summary' }))
  expect(props.onRemoveSummary).toHaveBeenCalledTimes(1)
})

test('Summarize now is disabled while nothing is dropped', async () => {
  const user = userEvent.setup()
  mount({
    settings: { ...DEFAULT_CONTEXT_SETTINGS },
    plan: planPlaygroundContext({
      messages: history,
      settings: { ...DEFAULT_CONTEXT_SETTINGS },
    }),
  })
  await openPanel(user)

  expect(
    await screen.findByRole('button', { name: 'Summarize now' })
  ).toBeDisabled()
})
