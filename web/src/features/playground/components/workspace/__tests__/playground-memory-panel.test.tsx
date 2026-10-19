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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import type { ComponentProps } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { PlaygroundMemoryPanel } from '../playground-memory-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const memoryWire = {
  id: 'pgm_1',
  content: 'Prefers concise answers.',
  category: 'preference',
  source_session_id: 'pgs_1',
  enabled: true,
  created_at: 10,
  updated_at: 20,
}

const emptyListing = { items: [], total: 0, limit: 100 }

let testI18n: i18n
let queryClient: QueryClient

function renderPanel(
  overrides: Partial<ComponentProps<typeof PlaygroundMemoryPanel>> = {}
) {
  const callbacks = {
    onExtractionChange: vi.fn(),
    onOpenSourceSession: vi.fn(),
  }
  const view = render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={queryClient}>
        <PlaygroundMemoryPanel
          active
          extraction={{ enabled: false, model: '' }}
          models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
          userId={7}
          {...callbacks}
          {...overrides}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
  return { ...callbacks, ...view }
}

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

afterEach(() => vi.restoreAllMocks())

test('lists memories, jumps to the source and toggles inclusion', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [memoryWire], total: 1, limit: 100 },
    },
  })
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({
    data: { success: true, data: { ...memoryWire, enabled: false } },
  })
  const callbacks = renderPanel()

  expect(await screen.findByText('Prefers concise answers.')).toBeVisible()
  expect(screen.getByText('1 of 100')).toBeVisible()
  expect(screen.getByText('Preference')).toBeVisible()

  await user.click(
    screen.getByRole('button', { name: 'View source conversation' })
  )
  expect(callbacks.onOpenSourceSession).toHaveBeenCalledWith('pgs_1')

  await user.click(
    screen.getByRole('switch', { name: 'Include this memory in requests' })
  )
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  expect(patch).toHaveBeenCalledWith(
    '/api/playground/memories/pgm_1',
    { enabled: false },
    expect.anything()
  )
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
})

test('creating a memory posts the trimmed content with the chosen category', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [memoryWire], total: 1, limit: 100 },
    },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        ...memoryWire,
        id: 'pgm_new',
        content: 'Uses TypeScript daily.',
        category: 'general',
        source_session_id: null,
      },
    },
  })
  renderPanel()

  await screen.findByText('Prefers concise answers.')
  await user.click(screen.getByRole('button', { name: 'New memory' }))
  await user.type(
    await screen.findByLabelText('Memory content'),
    '  Uses TypeScript daily.  '
  )
  await user.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith(
    '/api/playground/memories',
    { content: 'Uses TypeScript daily.', category: 'general' },
    expect.anything()
  )
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
})

test('deleting a memory confirms first and refreshes the empty list', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get')
    .mockResolvedValueOnce({
      data: {
        success: true,
        data: { items: [memoryWire], total: 1, limit: 100 },
      },
    })
    .mockResolvedValue({
      data: { success: true, data: emptyListing },
    })
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { success: true, data: null } })
  renderPanel()

  await screen.findByText('Prefers concise answers.')
  await user.click(screen.getByRole('button', { name: 'Delete memory' }))
  await user.click(await screen.findByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/playground/memories/pgm_1',
      expect.anything()
    )
  )
  expect(await screen.findByText('No memories yet')).toBeVisible()
})

test('the extraction switch reports the opt-in without changing the stored model', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [memoryWire], total: 1, limit: 100 },
    },
  })
  const callbacks = renderPanel()

  await screen.findByText('Prefers concise answers.')
  await user.click(
    screen.getByRole('switch', { name: 'Learn memories automatically' })
  )

  expect(callbacks.onExtractionChange).toHaveBeenCalledWith({
    enabled: true,
    model: '',
  })
})
