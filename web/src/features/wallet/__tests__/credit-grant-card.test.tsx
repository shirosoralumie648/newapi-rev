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
import { afterEach, expect, test, vi } from 'vitest'

import { CreditGrantCard } from '@/features/wallet/components/credit-grant-card'
import { api } from '@/lib/api'
import { formatQuota } from '@/lib/format'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

type WalletView = {
  user_id: number
  total_quota: number
  paid_quota: number
  grant_quota: number
  expired_quota: number
  grants: Array<{
    grant_id: number
    source: string
    remaining: number
    expires_at: number
    created_at: number
  }>
}

function walletView(overrides: Partial<WalletView> = {}): WalletView {
  return {
    user_id: 7,
    total_quota: 1_500,
    paid_quota: 400,
    grant_quota: 1_000,
    expired_quota: 100,
    grants: [
      {
        grant_id: 11,
        source: 'checkin',
        remaining: 600,
        expires_at: 1_700_003_600,
        created_at: 1_700_000_000,
      },
      {
        grant_id: 12,
        source: 'gift',
        remaining: 300,
        expires_at: 0,
        created_at: 1_700_000_000,
      },
    ],
    ...overrides,
  }
}

const STATS = {
  total_topup: 5_000,
  total_granted: 2_000,
  total_remaining: 1_000,
  total_spent: 1_000,
  total_consumed: 3_000,
  total_refunded: 200,
  total_expired: 300,
  sources: [
    {
      source: 'checkin',
      granted: 1_200,
      remaining: 600,
      spent: 600,
      grants: 4,
      accounts: 3,
    },
  ],
}

/** api.get resolves an AxiosResponse; only the payload matters here. */
function respond(data: unknown): never {
  return { data } as never
}

function mockApi(wallet: WalletView, withStats = false) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/user/self/wallet/grants') {
      return respond({ success: true, data: wallet })
    }
    if (url === '/api/user/wallet/grants/stats' && withStats) {
      return respond({ success: true, data: STATS })
    }
    throw new Error(`unexpected request: ${url}`)
  })
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <CreditGrantCard />
    </QueryClientProvider>
  )
}

function signInAs(role: number) {
  useAuthStore.setState((state) => ({
    auth: {
      ...state.auth,
      user: { id: 1, username: 'viewer', role },
    },
  }))
}

afterEach(() => {
  useAuthStore.setState((state) => ({ auth: { ...state.auth, user: null } }))
})

test('lists the paid balance, the grant buckets and their validity', async () => {
  mockApi(walletView())
  renderCard()

  expect(await screen.findByText('Check-in')).toBeVisible()
  expect(screen.getByText('Gift')).toBeVisible()
  expect(screen.getByText('Paid balance')).toBeVisible()
  expect(screen.getByText('Granted credit')).toBeVisible()
  expect(screen.getByText('Expired credit')).toBeVisible()
  expect(screen.getByText(formatQuota(1_000))).toBeVisible()
  expect(screen.getByText(formatQuota(600))).toBeVisible()
  expect(screen.getByText(formatQuota(100))).toBeVisible()
  expect(screen.getByText('Never expires')).toBeVisible()
  // The bucket with a validity shows the expiry date instead.
  expect(
    screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  ).toBeVisible()
})

test('shows the empty state when the account holds no granted credit', async () => {
  mockApi(
    walletView({
      grant_quota: 0,
      grants: [],
      total_quota: 400,
      paid_quota: 400,
      expired_quota: 0,
    })
  )
  renderCard()

  expect(await screen.findByText('No credit grants')).toBeVisible()
  expect(
    screen.getByText(
      'Sign-in rewards, invitation rewards, redemption codes and administrator gifts appear here.'
    )
  ).toBeVisible()
})

test('shows the error state when the buckets cannot be loaded', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'))
  renderCard()

  expect(await screen.findByText('Failed to load credit grants')).toBeVisible()
})

test('reads the platform totals by source for administrators only', async () => {
  signInAs(ROLE.ADMIN)
  const get = mockApi(walletView(), true)
  renderCard()

  expect(await screen.findByText('Wallet totals')).toBeVisible()
  expect(await screen.findByText(formatQuota(5_000))).toBeVisible()
  expect(screen.getByText(formatQuota(2_000))).toBeVisible()
  expect(screen.getByText(formatQuota(3_000))).toBeVisible()
  expect(get).toHaveBeenCalledWith('/api/user/wallet/grants/stats')
})

test('a regular user never requests the platform totals', async () => {
  signInAs(ROLE.USER)
  const get = mockApi(walletView(), true)
  renderCard()

  expect(await screen.findByText('Check-in')).toBeVisible()
  expect(get).not.toHaveBeenCalledWith('/api/user/wallet/grants/stats')
})
