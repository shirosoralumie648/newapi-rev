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
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'

import { DEFAULT_DEVELOPER_OPTIONS } from '../../../constants'
import type { PlaygroundDeveloperOptions } from '../../../types'
import { PlaygroundDeveloperPanel } from '../playground-developer-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

let testI18n: i18n

function renderPanel(
  options: PlaygroundDeveloperOptions = DEFAULT_DEVELOPER_OPTIONS
) {
  const onOptionsChange = vi.fn()
  render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundDeveloperPanel
        onOptionsChange={onOptionsChange}
        options={options}
      />
    </I18nextProvider>
  )
  return { onOptionsChange }
}

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

test('the trigger claims an effect only while the settings are active', () => {
  const active: PlaygroundDeveloperOptions = {
    ...DEFAULT_DEVELOPER_OPTIONS,
    enabled: true,
    tools: [{ type: 'function', function: { name: 'lookup_order' } }],
  }
  renderPanel(active)

  expect(
    screen.getByRole('button', { name: 'Developer settings' })
  ).toHaveAttribute('aria-pressed', 'true')
})

test('saving a defined tool reports the wire-ready developer settings', async () => {
  const user = userEvent.setup()
  const { onOptionsChange } = renderPanel()

  await user.click(screen.getByRole('button', { name: 'Developer settings' }))
  await user.click(await screen.findByRole('button', { name: 'Add tool' }))
  await user.type(screen.getByLabelText('Name'), 'lookup_order')
  await user.type(screen.getByLabelText('Description'), 'Look up one order.')
  fireEvent.change(screen.getByLabelText('Parameter schema (JSON)'), {
    target: { value: '{"type":"object","required":["id"]}' },
  })
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(onOptionsChange).toHaveBeenCalledTimes(1)
  expect(onOptionsChange).toHaveBeenCalledWith({
    enabled: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup_order',
          description: 'Look up one order.',
          parameters: { type: 'object', required: ['id'] },
        },
      },
    ],
    toolChoice: '',
    responseFormat: { type: 'text' },
  })
})

test('an invalid parameter schema blocks the save and explains why', async () => {
  const user = userEvent.setup()
  const { onOptionsChange } = renderPanel()

  await user.click(screen.getByRole('button', { name: 'Developer settings' }))
  await user.click(await screen.findByRole('button', { name: 'Add tool' }))
  await user.type(screen.getByLabelText('Name'), 'lookup_order')
  fireEvent.change(screen.getByLabelText('Parameter schema (JSON)'), {
    target: { value: '{' },
  })
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(onOptionsChange).not.toHaveBeenCalled()
  expect(
    await screen.findByText('The JSON Schema must be a valid JSON object.')
  ).toBeVisible()
})

test('an unnamed tool row is a draft and does not block the save', async () => {
  const user = userEvent.setup()
  const { onOptionsChange } = renderPanel()

  await user.click(screen.getByRole('button', { name: 'Developer settings' }))
  await user.click(await screen.findByRole('button', { name: 'Add tool' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(onOptionsChange).toHaveBeenCalledWith({
    enabled: false,
    tools: [],
    toolChoice: '',
    responseFormat: { type: 'text' },
  })
})

test('a stored response schema loads into the editor and saves back unchanged', async () => {
  const user = userEvent.setup()
  const stored: PlaygroundDeveloperOptions = {
    enabled: false,
    tools: [],
    toolChoice: '',
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'order_summary',
        schema: {
          type: 'object',
          properties: { total: { type: 'number' } },
          required: ['total'],
        },
      },
    },
  }
  const { onOptionsChange } = renderPanel(stored)

  await user.click(screen.getByRole('button', { name: 'Developer settings' }))
  expect(await screen.findByLabelText('Schema name')).toHaveValue(
    'order_summary'
  )
  await user.click(
    screen.getByRole('switch', { name: 'Enable developer settings' })
  )
  await user.click(screen.getByRole('button', { name: 'Save' }))

  expect(onOptionsChange).toHaveBeenCalledWith({
    ...stored,
    enabled: true,
  })
})
