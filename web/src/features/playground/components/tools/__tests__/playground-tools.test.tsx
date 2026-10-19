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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import * as toolsApi from '../../../tools-api'
import { PlaygroundTools } from '../playground-tools'

vi.mock('../../../tools-api', () => ({
  runEmbeddings: vi.fn(),
  runRerank: vi.fn(),
  runModerations: vi.fn(),
}))

vi.mock('../../../hooks', () => ({
  usePlaygroundMessageCosts: () => ({
    data: { enabled: true, costs: new Map() },
  }),
}))

const clients: QueryClient[] = []

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <PlaygroundTools />
    </QueryClientProvider>
  )
  return client
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/user/self/groups') {
      return {
        data: {
          success: true,
          data: { default: { desc: '', ratio: 1, name: 'Default' } },
        },
      } as never
    }
    if (url === '/api/user/models') {
      return {
        data: {
          success: true,
          data: [
            'text-embedding-3-small',
            'rerank-model',
            'omni-moderation-latest',
          ],
        },
      } as never
    }
    return { data: { success: true, data: [] } } as never
  })
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
})

async function loadTools() {
  mount()
  await screen.findByDisplayValue('text-embedding-3-small')
}

test('shows the server embedding limit and disables Run for too many inputs', async () => {
  await loadTools()
  const input = screen.getByLabelText('Inputs')
  fireEvent.change(input, {
    target: {
      value: Array.from({ length: 65 }, (_, index) => `input ${index}`).join(
        '\n'
      ),
    },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Split the text into no more than 64 inputs.'
  )
  const panel = screen.getByRole('tabpanel', { name: 'Embeddings' })
  expect(within(panel).getByRole('button', { name: 'Run' })).toBeDisabled()
})

test('renders embedding dimensions and pairwise cosine similarity', async () => {
  vi.mocked(toolsApi.runEmbeddings).mockResolvedValue({
    data: {
      items: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [1, 0] },
      ],
    },
    raw: { data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] },
    requestId: 'req_embedding',
  })
  await loadTools()
  fireEvent.change(screen.getByLabelText('Inputs'), {
    target: { value: 'first\nsecond' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Run' }))

  expect(await screen.findByText('2 dimensions')).toBeVisible()
  expect(screen.getByText('Pairwise cosine similarity')).toBeVisible()
  expect(screen.getAllByText('1.00').length).toBeGreaterThan(0)
  expect(screen.getByText('req_embedding')).toBeVisible()
})

test('orders rerank results by score instead of provider order', async () => {
  vi.mocked(toolsApi.runRerank).mockResolvedValue({
    data: {
      results: [
        { index: 0, score: 0.2 },
        { index: 1, score: 0.9 },
      ],
    },
    raw: { results: [] },
    requestId: 'req_rerank',
  })
  await loadTools()
  await userEvent.click(screen.getByRole('tab', { name: 'Rerank' }))
  const panel = screen.getByRole('tabpanel', { name: 'Rerank' })
  fireEvent.change(within(panel).getByLabelText('Query'), {
    target: { value: 'query' },
  })
  fireEvent.change(within(panel).getByLabelText('Candidates'), {
    target: { value: 'candidate a\ncandidate b' },
  })
  await userEvent.click(within(panel).getByRole('button', { name: 'Run' }))

  await waitFor(() => expect(within(panel).getByText('0.90')).toBeVisible())
  const rows = within(panel).getAllByRole('row')
  expect(within(rows[1]).getByText('candidate b')).toBeVisible()
  expect(within(rows[2]).getByText('candidate a')).toBeVisible()
})

test('shows moderation categories, scores and the provider decision', async () => {
  vi.mocked(toolsApi.runModerations).mockResolvedValue({
    data: {
      results: [
        {
          flagged: false,
          categories: { hate: false },
          categoryScores: { hate: 0.9 },
        },
      ],
    },
    raw: { results: [] },
    requestId: 'req_moderation',
  })
  await loadTools()
  await userEvent.click(screen.getByRole('tab', { name: 'Moderation' }))
  const panel = screen.getByRole('tabpanel', { name: 'Moderation' })
  fireEvent.change(within(panel).getByLabelText('Text'), {
    target: { value: 'hello' },
  })
  await userEvent.click(within(panel).getByRole('button', { name: 'Run' }))

  expect(
    (await within(panel).findAllByText('Not flagged')).length
  ).toBeGreaterThan(0)
  expect(within(panel).getByText('hate')).toBeVisible()
  expect(within(panel).getByText('0.90')).toBeVisible()
})
