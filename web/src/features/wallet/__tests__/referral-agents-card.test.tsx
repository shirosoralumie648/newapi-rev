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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Toaster } from 'sonner'
import { expect, test, vi } from 'vitest'

import { ReferralAgentsCard } from '@/features/wallet/components/referral-agents-card'
import type { ReferralAgentItem } from '@/features/wallet/types'
import { api } from '@/lib/api'

/** api.get resolves an AxiosResponse; only the payload matters here. */
function respond(data: unknown): never {
  return { data } as never
}

function makeAgent(
  overrides: Partial<ReferralAgentItem> = {}
): ReferralAgentItem {
  return {
    id: 1,
    user_id: 5,
    tier_id: '',
    rate_percent: null,
    note: '',
    marked_by: 1,
    created_at: 1700000000,
    updated_at: 1700000000,
    username: 'alice',
    display_name: 'Alice',
    group: 'vip',
    tier_name: '',
    effective_rate_percent: 25,
    rate_source: 'group',
    ...overrides,
  }
}

function mockAgents(items: ReferralAgentItem[], total: number) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url.startsWith('/api/user/referral/agents?')) {
      return respond({
        success: true,
        data: {
          items,
          total,
          tiers: [{ id: 'bronze', name: 'Bronze', rate_percent: 40 }],
        },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  })
}

function mockMark() {
  return vi
    .spyOn(api, 'put')
    .mockImplementation(async () => respond({ success: true }))
}

function mockClear() {
  return vi
    .spyOn(api, 'delete')
    .mockImplementation(async () => respond({ success: true }))
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ReferralAgentsCard />
      <Toaster />
    </QueryClientProvider>
  )
}

async function renderEmptyCard() {
  mockAgents([], 0)
  renderCard()
  await screen.findByText('No referral agents yet')
}

test('lists marked accounts with their effective rate and its source', async () => {
  mockAgents([makeAgent()], 1)
  renderCard()

  expect(await screen.findByText('Alice')).toBeVisible()
  expect(screen.getByText('25%')).toBeVisible()
  expect(screen.getByText('User group')).toBeVisible()
  expect(screen.getByText('Inherit group configuration')).toBeVisible()
})

test('rejects an invalid user id before calling the API', async () => {
  const put = mockMark()
  await renderEmptyCard()

  fireEvent.change(screen.getByLabelText('User ID'), {
    target: { value: 'abc' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Mark agent' }))

  expect(await screen.findByText('Enter a valid user ID.')).toBeVisible()
  expect(put).not.toHaveBeenCalled()
})

test('rejects a rate override outside 0 and 100', async () => {
  const put = mockMark()
  await renderEmptyCard()

  fireEvent.change(screen.getByLabelText('User ID'), {
    target: { value: '5' },
  })
  fireEvent.change(screen.getByLabelText('Rate override (%)'), {
    target: { value: '150' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Mark agent' }))

  expect(
    await screen.findByText(
      'The commission rate must be a number between 0 and 100.'
    )
  ).toBeVisible()
  expect(put).not.toHaveBeenCalled()
})

test('marks an account with its single-account rate override', async () => {
  const put = mockMark()
  await renderEmptyCard()

  fireEvent.change(screen.getByLabelText('User ID'), {
    target: { value: '5' },
  })
  fireEvent.change(screen.getByLabelText('Rate override (%)'), {
    target: { value: '12' },
  })
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'top partner' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Mark agent' }))

  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/api/user/5/referral-agent', {
      tier_id: '',
      rate_percent: 12,
      note: 'top partner',
    })
  )
  expect(await screen.findByText('Referral agent updated')).toBeVisible()
  expect(screen.getByLabelText('User ID')).toHaveValue('')
  expect(screen.getByLabelText('Rate override (%)')).toHaveValue('')
})

test('clears a mark only after the confirmation', async () => {
  const remove = mockClear()
  mockAgents([makeAgent()], 1)
  renderCard()
  await screen.findByText('Alice')

  fireEvent.click(screen.getByRole('button', { name: 'Clear mark alice' }))
  expect(await screen.findByText('Clear referral agent mark')).toBeVisible()
  expect(remove).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Clear mark' }))

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith('/api/user/5/referral-agent')
  )
  expect(await screen.findByText('Referral agent mark cleared')).toBeVisible()
})

test('pages through the marked accounts', async () => {
  const get = mockAgents([makeAgent()], 45)
  renderCard()
  await screen.findByText('Alice')
  expect(
    screen.getByRole('button', { name: 'Go to previous page' })
  ).toBeDisabled()
  expect(screen.getByText('1 / 3')).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }))

  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/api/user/referral/agents?p=2&page_size=20'
    )
  )
  expect(screen.getByText('2 / 3')).toBeVisible()
})
