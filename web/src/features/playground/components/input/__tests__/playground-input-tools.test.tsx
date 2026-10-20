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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { beforeAll, expect, test, vi } from 'vitest'

import { PromptInputProvider } from '@/components/ai-elements/prompt-input'

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
} from '../../../constants'
import { planPlaygroundContext } from '../../../lib'
import { PlaygroundInputTools } from '../playground-input-tools'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

function renderTools(
  onClearMessages = vi.fn(),
  onSystemPromptChange = vi.fn(),
  systemPrompt = '',
  config = DEFAULT_CONFIG,
  onDictateTranscript?: (text: string) => void,
  webSearch?: {
    available: boolean
    enabled: boolean
    onChange: (value: boolean) => void
  },
  requestViewer?: {
    hasCapturedRequest: boolean
    onOpen: () => void
  },
  toolExecution?: {
    enabled: boolean
    maxRounds: number
    onEnabledChange: (value: boolean) => void
    onMaxRoundsChange: (value: number) => void
  },
  onConfigChange: (
    key: keyof typeof DEFAULT_CONFIG,
    value: unknown
  ) => void = () => undefined
) {
  // The dictation panel mounts a transcription mutation, which needs the query
  // client the app installs at its root.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <PromptInputProvider>
        <PlaygroundInputTools
          autoReadDefaultEnabled={false}
          autoReadEnabled={false}
          autoReadHasOverride={false}
          autoTitleDefaultEnabled
          autoTitleEnabled
          autoTitleHasOverride={false}
          anonymousCompare={false}
          config={config}
          contextPlan={planPlaygroundContext({
            messages: [],
            settings: DEFAULT_CONTEXT_SETTINGS,
          })}
          contextSettings={DEFAULT_CONTEXT_SETTINGS}
          contextSummary={null}
          hasCapturedRequest={requestViewer?.hasCapturedRequest ?? false}
          hasMessages
          models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
          compareModels={[]}
          onCompareModelsChange={() => undefined}
          onClearMessages={onClearMessages}
          onOpenRequestViewer={requestViewer?.onOpen}
          onAutoReadChange={() => undefined}
          onAutoReadDefaultChange={() => undefined}
          onAutoReadUseDefault={() => undefined}
          onAnonymousCompareChange={() => undefined}
          onAutoTitleChange={() => undefined}
          onAutoTitleDefaultChange={() => undefined}
          onAutoTitleUseDefault={() => undefined}
          onConfigChange={onConfigChange}
          onContextSettingsChange={() => undefined}
          onDictateTranscript={onDictateTranscript}
          onInsertText={() => undefined}
          onParameterEnabledChange={() => undefined}
          onRemoveContextSummary={() => undefined}
          onSummarizeContext={() => undefined}
          onSystemPromptChange={onSystemPromptChange}
          onToolExecutionEnabledChange={
            toolExecution?.onEnabledChange ?? (() => undefined)
          }
          onToolExecutionMaxRoundsChange={
            toolExecution?.onMaxRoundsChange ?? (() => undefined)
          }
          parameterEnabled={DEFAULT_PARAMETER_ENABLED}
          systemPrompt={systemPrompt}
          toolExecutionEnabled={toolExecution?.enabled ?? false}
          toolExecutionMaxRounds={toolExecution?.maxRounds ?? 5}
          webSearchAvailable={webSearch?.available}
          webSearchEnabled={webSearch?.enabled}
          onWebSearchChange={webSearch?.onChange}
        />
      </PromptInputProvider>
    </QueryClientProvider>
  )
  return { onClearMessages, onSystemPromptChange }
}

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    'API protocol': 'API protocol',
    Attach: 'Attach',
    'Anthropic Messages': 'Anthropic Messages',
    'Chat Completions': 'Chat Completions',
    Clear: 'Clear',
    'Clear chat history': 'Clear chat history',
    'Clear chat history?': 'Clear chat history?',
    'Not sent with this protocol: {{fields}}':
      'Not sent with this protocol: {{fields}}',
    Parameters: 'Parameters',
    'Prompt snippets': 'Prompt snippets',
    'Reasoning Effort': 'Reasoning Effort',
    Save: 'Save',
    Search: 'Search',
    'Search this turn': 'Search this turn',
    'Search the web with this turn': 'Search the web with this turn',
    'System prompt': 'System prompt',
    'System prompt cleared': 'System prompt cleared',
    'System prompt saved': 'System prompt saved',
    'The system prompt is sent to the model at the start of every request in this conversation.':
      'The system prompt is sent to the model at the start of every request in this conversation.',
    'View the request payload of the last send':
      'View the request payload of the last send',
    'e.g. You are a concise assistant.': 'e.g. You are a concise assistant.',
  })
})

test('clearing chat history asks for confirmation before removing messages', async () => {
  const user = userEvent.setup()
  const { onClearMessages } = renderTools()

  await user.click(screen.getByRole('button', { name: 'Clear chat history' }))
  expect(onClearMessages).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'Clear' }))
  expect(onClearMessages).toHaveBeenCalledTimes(1)
})

test('saving the system prompt persists the trimmed draft', async () => {
  const user = userEvent.setup()
  const { onSystemPromptChange } = renderTools()

  await user.click(screen.getByRole('button', { name: 'System prompt' }))
  const input = await screen.findByRole('textbox', { name: 'System prompt' })
  await user.type(input, '  Answer in French.  ')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(onSystemPromptChange).toHaveBeenCalledTimes(1)
  expect(onSystemPromptChange).toHaveBeenCalledWith('Answer in French.')
})

test('clearing the stored system prompt persists an empty value', async () => {
  const user = userEvent.setup()
  const { onSystemPromptChange } = renderTools(
    vi.fn(),
    vi.fn(),
    'Answer briefly.'
  )

  await user.click(screen.getByRole('button', { name: 'System prompt' }))
  await user.click(await screen.findByRole('button', { name: 'Clear' }))

  expect(onSystemPromptChange).toHaveBeenCalledWith('')
})

test('hides the web-search toggle when the administrator has not enabled it', () => {
  renderTools(vi.fn(), vi.fn(), '', DEFAULT_CONFIG, undefined, {
    available: false,
    enabled: false,
    onChange: vi.fn(),
  })

  expect(screen.queryByRole('button', { name: 'Search this turn' })).toBeNull()
})

test('toggles the next turn web search and exposes its pressed state', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  renderTools(vi.fn(), vi.fn(), '', DEFAULT_CONFIG, undefined, {
    available: true,
    enabled: true,
    onChange,
  })

  const toggle = screen.getByRole('button', { name: 'Search this turn' })
  expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await user.click(toggle)

  expect(onChange).toHaveBeenCalledWith(false)
})

test('wires the composer tool loop control to the account preference', async () => {
  const user = userEvent.setup()
  const onEnabledChange = vi.fn()
  renderTools(
    vi.fn(),
    vi.fn(),
    '',
    DEFAULT_CONFIG,
    undefined,
    undefined,
    undefined,
    {
      enabled: false,
      maxRounds: 5,
      onEnabledChange,
      onMaxRoundsChange: vi.fn(),
    }
  )

  await user.click(screen.getByRole('button', { name: 'Tool loop' }))
  await user.click(
    await screen.findByRole('switch', {
      name: 'Run supported tool calls automatically',
    })
  )

  expect(onEnabledChange).toHaveBeenCalledWith(true)
})

test('the dictation entry is offered when the composer accepts transcripts', () => {
  renderTools(vi.fn(), vi.fn(), '', DEFAULT_CONFIG, vi.fn())

  expect(screen.getByRole('button', { name: 'Dictation' })).toBeVisible()
})

test('the dictation entry is hidden when the composer accepts no transcripts', () => {
  renderTools()

  expect(screen.queryByRole('button', { name: 'Dictation' })).toBeNull()
})

test('offers the reasoning effort control for a model that accepts an effort', async () => {
  const user = userEvent.setup()
  renderTools(vi.fn(), vi.fn(), '', { ...DEFAULT_CONFIG, model: 'gpt-5' })

  await user.click(screen.getByRole('button', { name: 'Parameters' }))

  expect(await screen.findByText('Reasoning Effort')).toBeVisible()
})

test('hides the reasoning effort control for a model without an effort', async () => {
  const user = userEvent.setup()
  renderTools()

  await user.click(screen.getByRole('button', { name: 'Parameters' }))
  await screen.findByText('Temperature')

  expect(screen.queryByText('Reasoning Effort')).toBeNull()
})

test('the protocol selector reports the chosen wire protocol', async () => {
  const user = userEvent.setup()
  const onConfigChange = vi.fn()
  renderTools(
    undefined,
    undefined,
    '',
    DEFAULT_CONFIG,
    undefined,
    undefined,
    undefined,
    undefined,
    onConfigChange
  )

  const trigger = screen.getByRole('combobox', { name: 'API protocol' })
  expect(trigger).toHaveTextContent('Chat Completions')

  await user.click(trigger)
  await user.click(
    await screen.findByRole('option', { name: 'Anthropic Messages' })
  )

  expect(onConfigChange).toHaveBeenCalledWith('protocol', 'messages')
})

test('warns which composer parameters the selected protocol does not send', () => {
  renderTools(vi.fn(), vi.fn(), '', {
    ...DEFAULT_CONFIG,
    protocol: 'messages',
  })

  expect(
    screen.getByRole('img', {
      name: 'Not sent with this protocol: frequency_penalty, presence_penalty',
    })
  ).toBeVisible()
})

test('shows no protocol warning while the chat protocol forwards every parameter', () => {
  renderTools()

  expect(
    screen.queryByRole('img', { name: /^Not sent with this protocol:/ })
  ).toBeNull()
})
