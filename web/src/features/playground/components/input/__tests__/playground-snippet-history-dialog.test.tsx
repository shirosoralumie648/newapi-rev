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
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'

import type { PromptSnippetDetail } from '../../../types'
import { PlaygroundSnippetHistoryDialog } from '../playground-snippet-history-dialog'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const snippet: PromptSnippetDetail = {
  id: 'pgs_1',
  name: 'Review checklist',
  content: 'Line one.\nLine three.',
  currentVersion: 3,
  productionVersion: 2,
  versionCount: 3,
  createdAt: 1,
  updatedAt: 3,
  versions: [
    { version: 1, content: 'Line one.', byteSize: 9, createdAt: 1000 },
    {
      version: 2,
      content: 'Line one.\nLine two.',
      byteSize: 19,
      createdAt: 2000,
    },
    {
      version: 3,
      content: 'Line one.\nLine three.',
      byteSize: 21,
      createdAt: 3000,
    },
  ],
}

let testI18n: i18n

function renderHistory(
  props: Partial<Parameters<typeof PlaygroundSnippetHistoryDialog>[0]> = {}
) {
  const onRollback = vi.fn()
  render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundSnippetHistoryDialog
        error={null}
        onOpenChange={vi.fn()}
        onRetry={vi.fn()}
        onRollback={onRollback}
        open
        rollingBackVersion={null}
        snippet={snippet}
        status='ready'
        {...props}
      />
    </I18nextProvider>
  )
  return { onRollback }
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

test('versions are listed newest first with their immutable byte size', async () => {
  renderHistory()

  expect(await screen.findByText('v3')).toBeVisible()
  expect(screen.getByText('v2')).toBeVisible()
  expect(screen.getByText('v1')).toBeVisible()
  expect(screen.getByText('In production')).toBeVisible()
  expect(screen.getByText('Current version')).toBeVisible()
  expect(screen.getByText('21 bytes')).toBeVisible()
})

test('expanding a version shows a line diff against its predecessor', async () => {
  const user = userEvent.setup()
  renderHistory()

  await user.click(screen.getByText('v3'))

  expect(await screen.findByText('Compared with version 2')).toBeVisible()
  expect(screen.getByText('Added')).toBeVisible()
  expect(screen.getByText('Removed')).toBeVisible()
  expect(screen.getByText('Line two.')).toBeVisible()
  expect(screen.getByText('Line three.')).toBeVisible()
})

test('the first revision explains that it has no predecessor diff', async () => {
  const user = userEvent.setup()
  renderHistory()

  await user.click(screen.getByText('v1'))

  expect(await screen.findByText('Initial version')).toBeVisible()
})

test('rolling back asks for confirmation and moves the pointer to that version', async () => {
  const user = userEvent.setup()
  const { onRollback } = renderHistory()

  const firstVersion = screen.getByText('v1').closest('li')
  expect(firstVersion).not.toBeNull()
  await user.click(
    within(firstVersion as HTMLElement).getByRole('button', {
      name: 'Roll back to this version',
    })
  )
  expect(screen.getByText('Roll back to version 1?')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Roll back' }))

  expect(onRollback).toHaveBeenCalledExactlyOnceWith(1)
})
