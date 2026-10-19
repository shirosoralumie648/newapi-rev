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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { TaskLog } from '@/features/usage-logs/types'
import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { CanvasTaskList } from '../canvas-task-list'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

let testI18n: i18n

const generatedTask: TaskLog = {
  id: 21,
  user_id: 7,
  platform: 'openai',
  task_id: 'task-seed-42',
  action: 'GENERATE',
  channel_id: 3,
  group: 'default',
  quota: 500000,
  submit_time: 1700000000,
  start_time: 1700000000,
  finish_time: 1700000004,
  status: 'SUCCESS',
  properties: { origin_model_name: 'gpt-image-1' },
  generation: {
    kind: 'image',
    prompt: 'a red fox in snow',
    model: 'gpt-image-1',
    size: '1792x1024',
    quality: 'high',
    seed: 42,
    count: 2,
  },
}

function mockTaskEndpoint(tasks: TaskLog[]) {
  return vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/task/self')) {
      return {
        data: { success: true, data: { items: tasks, total: tasks.length } },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
}

function renderTaskList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <CanvasTaskList active onSendToCanvas={vi.fn()} showFilters search='' />
      </QueryClientProvider>
    </I18nextProvider>
  )
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('a task result shows its recorded generation parameters, elapsed time and cost', async () => {
  mockTaskEndpoint([generatedTask])
  renderTaskList()

  expect(await screen.findByText('a red fox in snow')).toBeVisible()
  expect(screen.getByText('gpt-image-1')).toBeVisible()
  expect(screen.getByText('1792x1024')).toBeVisible()
  expect(screen.getByText('high')).toBeVisible()
  expect(screen.getByText('Seed 42')).toBeVisible()
  expect(screen.getByText('Count 2')).toBeVisible()
  expect(screen.getByText('Elapsed 4.0s')).toBeVisible()
  expect(screen.getByText(/^Cost /)).toBeVisible()
})

test('generation filters narrow the durable task query on the server', async () => {
  const get = mockTaskEndpoint([generatedTask])
  const user = userEvent.setup()
  renderTaskList()

  await screen.findByText('a red fox in snow')
  await user.click(screen.getByRole('button', { name: 'Filters' }))
  await user.type(screen.getByLabelText('Filter by prompt'), 'red fox')
  await user.type(screen.getByLabelText('Filter by model'), 'gpt-image')
  await user.type(screen.getByLabelText('Filter by size'), '1792x1024')
  await user.type(screen.getByLabelText('Filter by quality'), 'high')
  await user.type(screen.getByLabelText('Filter by seed'), '42')
  await user.type(screen.getByLabelText('Filter by count'), '2')

  await waitFor(
    () =>
      expect(get).toHaveBeenCalledWith(
        '/api/task/self?p=1&page_size=20&generation_prompt=red+fox&generation_model=gpt-image&generation_size=1792x1024&generation_quality=high&generation_seed=42&generation_count=2'
      ),
    { timeout: 3000 }
  )

  await user.click(screen.getByRole('button', { name: 'Clear filters' }))
  await waitFor(
    () => {
      const calls = get.mock.calls
      expect(calls[calls.length - 1]?.[0]).toBe(
        '/api/task/self?p=1&page_size=20'
      )
    },
    { timeout: 3000 }
  )
})

test('a filter without matching task rows shows the filtered empty state', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/task/self')) {
      const items = url.includes('generation_seed=7') ? [] : [generatedTask]
      return {
        data: { success: true, data: { items, total: items.length } },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const user = userEvent.setup()
  renderTaskList()

  await screen.findByText('a red fox in snow')
  await user.click(screen.getByRole('button', { name: 'Filters' }))
  await user.type(screen.getByLabelText('Filter by seed'), '7')

  expect(await screen.findByText('No results found')).toBeVisible()
  expect(
    screen.queryByText('Start a generation and its status appears here.')
  ).not.toBeInTheDocument()
})
