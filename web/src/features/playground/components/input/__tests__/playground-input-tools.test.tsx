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

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { PlaygroundInputTools } from '../playground-input-tools'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

function renderTools(onClearMessages = vi.fn()) {
  render(
    <PromptInputProvider>
      <PlaygroundInputTools
        config={DEFAULT_CONFIG}
        hasMessages
        onClearMessages={onClearMessages}
        onConfigChange={() => undefined}
        onParameterEnabledChange={() => undefined}
        parameterEnabled={DEFAULT_PARAMETER_ENABLED}
      />
    </PromptInputProvider>
  )
  return onClearMessages
}

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    Attach: 'Attach',
    Clear: 'Clear',
    'Clear chat history': 'Clear chat history',
    'Clear chat history?': 'Clear chat history?',
    Search: 'Search',
  })
})

test('clearing chat history asks for confirmation before removing messages', async () => {
  const user = userEvent.setup()
  const onClearMessages = renderTools()

  await user.click(screen.getByRole('button', { name: 'Clear chat history' }))
  expect(onClearMessages).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: 'Clear' }))
  expect(onClearMessages).toHaveBeenCalledTimes(1)
})
