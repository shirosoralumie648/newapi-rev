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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import type { ComponentProps } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { PlaygroundSnippetPanel } from '../playground-snippet-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const snippetWire = {
  id: 'pgs_1',
  name: 'Review checklist',
  content: 'Check every endpoint for owner scoping.',
  created_at: 10,
  updated_at: 20,
}

let testI18n: i18n

function renderPanel(
  overrides: Partial<ComponentProps<typeof PlaygroundSnippetPanel>> = {}
) {
  const onInsertSnippet = vi.fn()
  const view = render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundSnippetPanel
        onInsertSnippet={onInsertSnippet}
        {...overrides}
      />
    </I18nextProvider>
  )
  return { onInsertSnippet, ...view }
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

afterEach(() => vi.restoreAllMocks())

test('lists the owner snippets and their budget after opening the panel', async () => {
  const user = userEvent.setup()
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [snippetWire], total: 1, limit: 50 },
    },
  })
  renderPanel()

  expect(screen.queryByText('Review checklist')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Prompt snippets' }))

  expect(await screen.findByText('Review checklist')).toBeVisible()
  expect(
    screen.getByText('Check every endpoint for owner scoping.')
  ).toBeVisible()
  expect(screen.getByText('1 of 50')).toBeVisible()
  expect(get).toHaveBeenCalledWith(
    '/api/playground/snippets',
    expect.anything()
  )
})

test('inserting a snippet hands its text to the composer', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [snippetWire], total: 1, limit: 50 },
    },
  })
  const { onInsertSnippet } = renderPanel()

  await user.click(screen.getByRole('button', { name: 'Prompt snippets' }))
  await screen.findByText('Review checklist')
  await user.click(screen.getByRole('button', { name: 'Insert' }))

  expect(onInsertSnippet).toHaveBeenCalledExactlyOnceWith(
    'Check every endpoint for owner scoping.'
  )
})

test('search narrows the owner snippets by name or text', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [
          snippetWire,
          {
            ...snippetWire,
            id: 'pgs_2',
            name: 'Polish translation',
            content: 'Translate carefully.',
          },
        ],
        total: 2,
        limit: 50,
      },
    },
  })
  renderPanel()

  await user.click(screen.getByRole('button', { name: 'Prompt snippets' }))
  await screen.findByText('Review checklist')
  await user.type(
    screen.getByRole('textbox', { name: 'Search prompt snippets' }),
    'translate carefully'
  )

  expect(screen.queryByText('Review checklist')).toBeNull()
  expect(screen.getByText('Polish translation')).toBeVisible()
})

test('creating a snippet posts the trimmed draft', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: { items: [], total: 0, limit: 50 } },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: { ...snippetWire, id: 'pgs_new', name: 'Reviewer' },
    },
  })
  renderPanel()

  await user.click(screen.getByRole('button', { name: 'Prompt snippets' }))
  await screen.findByText('No prompt snippets yet')
  await user.click(screen.getByRole('button', { name: 'New snippet' }))
  await user.type(await screen.findByLabelText('Snippet name'), '  Reviewer  ')
  await user.type(
    screen.getByLabelText('Snippet text'),
    'Answer with a checklist.'
  )
  await user.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith(
    '/api/playground/snippets',
    { name: 'Reviewer', content: 'Answer with a checklist.' },
    expect.anything()
  )
})

test('a full library disables creating another snippet', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [snippetWire], total: 1, limit: 1 },
    },
  })
  renderPanel()

  await user.click(screen.getByRole('button', { name: 'Prompt snippets' }))
  await screen.findByText('Review checklist')

  expect(screen.getByRole('button', { name: 'New snippet' })).toBeDisabled()
})

test('deleting a snippet confirms first and then removes it', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [snippetWire], total: 1, limit: 50 },
    },
  })
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { success: true, data: null } })
  renderPanel()

  await user.click(screen.getByRole('button', { name: 'Prompt snippets' }))
  await screen.findByText('Review checklist')
  await user.click(screen.getByRole('button', { name: 'Delete snippet' }))
  await user.click(await screen.findByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/playground/snippets/pgs_1',
      expect.anything()
    )
  )
  expect(screen.queryByText('Review checklist')).toBeNull()
})
