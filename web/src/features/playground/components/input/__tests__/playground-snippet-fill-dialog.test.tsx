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
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'

import { PlaygroundSnippetFillDialog } from '../playground-snippet-fill-dialog'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

let testI18n: i18n

function renderDialog(
  props: Partial<Parameters<typeof PlaygroundSnippetFillDialog>[0]> = {}
) {
  const onConfirm = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundSnippetFillDialog
        content='Summarize {{topic:general}} for {{audience}} in bullet points.'
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open
        target='composer'
        {...props}
      />
    </I18nextProvider>
  )
  return { onConfirm, onOpenChange }
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

test('defaults are prefilled and required variables block insertion until filled', async () => {
  const user = userEvent.setup()
  const { onConfirm } = renderDialog()

  expect(await screen.findByDisplayValue('general')).toBeVisible()
  expect(screen.getByLabelText('Preview')).toHaveTextContent(
    'Summarize general for  in bullet points.'
  )
  const insert = screen.getByRole('button', { name: 'Insert' })
  expect(insert).toBeDisabled()
  expect(
    screen.getByText('Fill in every variable that has no default.')
  ).toBeVisible()

  await user.type(screen.getByLabelText('audience'), 'engineers')

  expect(screen.getByLabelText('Preview')).toHaveTextContent(
    'Summarize general for engineers in bullet points.'
  )
  expect(insert).toBeEnabled()
  await user.click(insert)

  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(
    'Summarize general for engineers in bullet points.'
  )
})

test('editing a default changes the preview and the inserted text', async () => {
  const user = userEvent.setup()
  const { onConfirm } = renderDialog({
    content: 'Write in a {{tone:neutral}} tone.',
  })

  const tone = await screen.findByLabelText(/tone/)
  await user.clear(tone)
  await user.type(tone, 'friendly')
  await user.click(screen.getByRole('button', { name: 'Insert' }))

  expect(onConfirm).toHaveBeenCalledWith('Write in a friendly tone.')
})

test('the system prompt target names the destination on its confirm button', async () => {
  const user = userEvent.setup()
  const { onConfirm } = renderDialog({
    content: 'Always answer with {{language:English}}.',
    target: 'system',
  })

  await screen.findByDisplayValue('English')
  await user.click(
    screen.getByRole('button', { name: 'Insert into system prompt' })
  )

  expect(onConfirm).toHaveBeenCalledWith('Always answer with English.')
})
