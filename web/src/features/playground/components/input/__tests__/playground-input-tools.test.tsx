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
  onDictateTranscript?: (text: string) => void
) {
  render(
    <PromptInputProvider>
      <PlaygroundInputTools
        config={DEFAULT_CONFIG}
        contextPlan={planPlaygroundContext({
          messages: [],
          settings: DEFAULT_CONTEXT_SETTINGS,
        })}
        contextSettings={DEFAULT_CONTEXT_SETTINGS}
        contextSummary={null}
        hasMessages
        models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
        onClearMessages={onClearMessages}
        onConfigChange={() => undefined}
        onContextSettingsChange={() => undefined}
        onDictateTranscript={onDictateTranscript}
        onParameterEnabledChange={() => undefined}
        onRemoveContextSummary={() => undefined}
        onSummarizeContext={() => undefined}
        onSystemPromptChange={onSystemPromptChange}
        parameterEnabled={DEFAULT_PARAMETER_ENABLED}
        systemPrompt={systemPrompt}
      />
    </PromptInputProvider>
  )
  return { onClearMessages, onSystemPromptChange }
}

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    Attach: 'Attach',
    Clear: 'Clear',
    'Clear chat history': 'Clear chat history',
    'Clear chat history?': 'Clear chat history?',
    Save: 'Save',
    Search: 'Search',
    'System prompt': 'System prompt',
    'System prompt cleared': 'System prompt cleared',
    'System prompt saved': 'System prompt saved',
    'The system prompt is sent to the model at the start of every request in this conversation.':
      'The system prompt is sent to the model at the start of every request in this conversation.',
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

test('the dictation entry is offered when the composer accepts transcripts', () => {
  renderTools(vi.fn(), vi.fn(), '', vi.fn())

  expect(screen.getByRole('button', { name: 'Dictation' })).toBeVisible()
})

test('the dictation entry is hidden when the composer accepts no transcripts', () => {
  renderTools()

  expect(screen.queryByRole('button', { name: 'Dictation' })).toBeNull()
})
