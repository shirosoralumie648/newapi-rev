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

import { ReferralAgentTiersCard } from '@/features/wallet/components/referral-agent-tiers-card'
import { api } from '@/lib/api'
import { formatPercent } from '@/lib/format'

const TIERS_OPTION_KEY = 'referral_setting.agent_tiers'

/** api.get resolves an AxiosResponse; only the payload matters here. */
function respond(data: unknown): never {
  return { data } as never
}

function mockOptions(value: string | null) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/option/') {
      const options = value === null ? [] : [{ key: TIERS_OPTION_KEY, value }]
      return respond({ success: true, data: options })
    }
    throw new Error(`unexpected request: ${url}`)
  })
}

function mockSave() {
  return vi
    .spyOn(api, 'put')
    .mockImplementation(async () => respond({ success: true }))
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ReferralAgentTiersCard />
      <Toaster />
    </QueryClientProvider>
  )
}

async function openEmptyEditor() {
  mockOptions('[]')
  renderCard()
  await screen.findByText('No agent tiers configured')
  fireEvent.click(screen.getByRole('button', { name: 'Edit tiers' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add tier' }))
}

function fillTier(
  index: number,
  values: { id: string; name: string; rate: string }
) {
  fireEvent.change(screen.getAllByLabelText('Tier identifier')[index], {
    target: { value: values.id },
  })
  fireEvent.change(screen.getAllByLabelText('Tier name')[index], {
    target: { value: values.name },
  })
  fireEvent.change(screen.getAllByLabelText(/Commission rate/)[index], {
    target: { value: values.rate },
  })
}

test('shows the empty state when no tiers are configured', async () => {
  mockOptions(null)
  renderCard()

  expect(await screen.findByText('No agent tiers configured')).toBeVisible()
})

test('lists the configured tiers and prefills the editor from them', async () => {
  mockOptions(
    JSON.stringify([
      { id: 'bronze', name: 'Bronze', rate_percent: 40 },
      { id: 'gold', name: 'Gold', rate_percent: 62.5 },
    ])
  )
  renderCard()

  expect(await screen.findByText('Bronze')).toBeVisible()
  expect(screen.getByText('bronze')).toBeVisible()
  expect(screen.getByText(formatPercent(62.5))).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: 'Edit tiers' }))
  expect(screen.getAllByLabelText('Tier identifier')[0]).toHaveValue('bronze')
  expect(screen.getAllByLabelText('Tier name')[1]).toHaveValue('Gold')
  expect(screen.getAllByLabelText(/Commission rate/)[1]).toHaveValue('62.5')
})

test('rejects a tier without an identifier or a name', async () => {
  const put = mockSave()
  await openEmptyEditor()

  fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }))

  expect(
    await screen.findByText('Tier identifier and name are required.')
  ).toBeVisible()
  expect(put).not.toHaveBeenCalled()
})

test('rejects duplicate tier identifiers', async () => {
  const put = mockSave()
  await openEmptyEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Add tier' }))
  fillTier(0, { id: 'bronze', name: 'Bronze', rate: '40' })
  fillTier(1, { id: 'bronze', name: 'Silver', rate: '30' })

  fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }))

  expect(
    await screen.findByText('Tier identifiers must be unique.')
  ).toBeVisible()
  expect(put).not.toHaveBeenCalled()
})

test('rejects a commission rate outside 0 and 100', async () => {
  const put = mockSave()
  await openEmptyEditor()
  fillTier(0, { id: 'bronze', name: 'Bronze', rate: '120' })

  fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }))

  expect(
    await screen.findByText(
      'Tier commission rates must be numbers between 0 and 100.'
    )
  ).toBeVisible()
  expect(put).not.toHaveBeenCalled()
})

test('saves the whole catalogue as the option value', async () => {
  const put = mockSave()
  await openEmptyEditor()
  fillTier(0, { id: 'bronze', name: 'Bronze', rate: '40' })

  fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }))

  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/api/option/', {
      key: TIERS_OPTION_KEY,
      value: JSON.stringify([
        { id: 'bronze', name: 'Bronze', rate_percent: 40 },
      ]),
    })
  )
  expect(await screen.findByText('Setting updated successfully')).toBeVisible()
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Save tiers' })
    ).not.toBeInTheDocument()
  )
})
