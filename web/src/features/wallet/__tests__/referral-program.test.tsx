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
import { afterEach, expect, test, vi } from 'vitest'

import { EMPTY_REFERRAL_STATS_SUMMARY } from '@/features/wallet/lib'
import { ReferralProgram } from '@/features/wallet/referral-program'
import type {
  ReferralAgentPage,
  ReferralAgentProfile,
  ReferralInvitation,
  ReferralInvitationPage,
} from '@/features/wallet/types'
import { api } from '@/lib/api'
import { formatPercent } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

/** api.get resolves an AxiosResponse; only the payload matters here. */
function respond(data: unknown): never {
  return { data } as never
}

function makeProfile(
  overrides: Partial<ReferralAgentProfile> = {}
): ReferralAgentProfile {
  return {
    marked: true,
    tier_id: 'gold',
    tier_name: 'Gold partner',
    rate_percent: 60,
    rate_source: 'tier',
    enabled: true,
    summary: EMPTY_REFERRAL_STATS_SUMMARY,
    ...overrides,
  }
}

function makeInvitation(
  id: number,
  identifier: string,
  pendingQuota: number
): ReferralInvitation {
  return {
    invitee_id: id,
    identifier,
    source: 'link',
    bound_at: 1700000000 + id,
    commission_ends_at: 0,
    pending_quota: pendingQuota,
    locked_quota: 0,
    settled_quota: 0,
    total_paid_quota: 0,
    commission_count: pendingQuota > 0 ? 1 : 0,
  }
}

function mockApi(options: {
  profile: ReferralAgentProfile | 'error'
  invitations?: ReferralInvitationPage
  agents?: ReferralAgentPage
}) {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/api/user/self/referral-agent') {
      if (options.profile === 'error') throw new Error('profile load failed')
      return respond({ success: true, data: options.profile })
    }
    if (url.startsWith('/api/user/self/referrals?')) {
      return respond({
        success: true,
        data: options.invitations ?? {
          items: [],
          total: 0,
          window_months: 0,
          commission_enabled: true,
        },
      })
    }
    if (url.startsWith('/api/user/referral/agents?')) {
      return respond({
        success: true,
        data: options.agents ?? { items: [], total: 0, tiers: [] },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  })
}

function renderProgram() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ReferralProgram />
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

test('renders the marked agent profile with its winning rate source', async () => {
  mockApi({
    profile: makeProfile({
      summary: {
        ...EMPTY_REFERRAL_STATS_SUMMARY,
        total_invitees: 2,
        invitees_with_commission: 1,
      },
    }),
  })
  renderProgram()

  expect(await screen.findByText('Gold partner')).toBeVisible()
  expect(screen.getByText('Referral agent')).toBeVisible()
  expect(screen.getByText(formatPercent(60))).toBeVisible()
  expect(screen.getByText('Agent tier')).toBeVisible()
  expect(screen.getByText('Invitees')).toBeVisible()
})

test('renders the unmarked state on the global default', async () => {
  mockApi({
    profile: makeProfile({
      marked: false,
      tier_id: '',
      tier_name: '',
      rate_percent: 20,
      rate_source: 'default',
    }),
  })
  renderProgram()

  expect(await screen.findByText('Not a referral agent')).toBeVisible()
  expect(await screen.findByText(formatPercent(20))).toBeVisible()
  expect(screen.getByText('Global default')).toBeVisible()
})

test('lists the invitees of the caller and pages through them', async () => {
  const get = mockApi({
    profile: makeProfile(),
    invitations: {
      items: [makeInvitation(7, 'al***', 1000)],
      total: 45,
      window_months: 12,
      commission_enabled: true,
    },
  })
  renderProgram()

  expect(await screen.findByText('al***')).toBeVisible()
  expect(screen.getByText('1 / 3')).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }))

  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/api/user/self/referrals?p=2&page_size=20'
    )
  )
  expect(await screen.findByText('2 / 3')).toBeVisible()
})

test('keeps the administration cards hidden from regular users', async () => {
  const get = mockApi({ profile: makeProfile() })
  renderProgram()
  await screen.findByText('Gold partner')

  expect(screen.queryByText('Referral agent tiers')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Mark agent' })
  ).not.toBeInTheDocument()
  expect(get).not.toHaveBeenCalledWith(
    expect.stringContaining('/api/user/referral/agents')
  )
})

test('shows the administration cards to administrators', async () => {
  signInAs(100)
  mockApi({ profile: makeProfile() })
  renderProgram()

  expect(await screen.findByText('Referral agent tiers')).toBeVisible()
  expect(await screen.findByText('No referral agents yet')).toBeVisible()
})

test('shows an error state when the profile cannot be loaded', async () => {
  mockApi({ profile: 'error' })
  renderProgram()

  expect(
    await screen.findByText('Failed to load the referral agent profile')
  ).toBeVisible()
})

test('keeps recorded amounts listed while the commission is disabled', async () => {
  mockApi({ profile: makeProfile({ enabled: false }) })
  renderProgram()

  expect(
    await screen.findByText(
      'Referral commission is disabled; recorded amounts remain listed.'
    )
  ).toBeVisible()
})
