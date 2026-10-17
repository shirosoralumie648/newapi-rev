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
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { WalletDebtDialog } from '@/features/wallet/components/dialogs/wallet-debt-dialog'
import { api } from '@/lib/api'

function makeDebtor(id: number, username: string, debt: number) {
  return {
    user_id: id,
    username,
    group: 'default',
    quota: 0,
    debt,
    updated_at: 1700000000 + id,
  }
}

function mockDebtorPage(
  total: number,
  items = [] as ReturnType<typeof makeDebtor>[]
) {
  return { data: { success: true, data: { items, total } } }
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <WalletDebtDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>
  )
}

it('lists accounts with outstanding debt and their amounts', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    mockDebtorPage(2, [
      makeDebtor(7, 'debtor-a', 2500),
      makeDebtor(8, 'debtor-b', 400),
    ])
  )
  renderDialog()

  expect(await screen.findByText('debtor-a')).toBeVisible()
  expect(screen.getByText('debtor-b')).toBeVisible()
  expect(api.get).toHaveBeenCalledWith(
    '/api/user/wallet/debts?p=1&page_size=20'
  )
  // The owed amount is listed next to the account and below the table headers.
  expect(screen.getAllByText('Wallet Debt').length).toBeGreaterThan(0)
  expect(document.body.textContent).toContain('2 accounts in debt')
})

it('shows an empty state when no account owes the platform', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(mockDebtorPage(0))
  renderDialog()

  expect(await screen.findByText('No wallet debts')).toBeVisible()
  expect(
    screen.getByText('No account currently owes the platform.')
  ).toBeVisible()
})

it('shows an error state when the debt list cannot be loaded', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'))
  renderDialog()

  expect(await screen.findByText('Failed to load wallet debts')).toBeVisible()
})
