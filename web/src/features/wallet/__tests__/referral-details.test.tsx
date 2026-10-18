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
import { afterEach, expect, it, vi } from 'vitest'

import { AffiliateRewardsCard } from '@/features/wallet/components/affiliate-rewards-card'
import { ReferralDetailsDialog } from '@/features/wallet/components/dialogs/referral-details-dialog'
import type { UserWalletData } from '@/features/wallet/types'
import { api } from '@/lib/api'

function makeInvitation(id: number, identifier: string, pendingQuota: number) {
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

function mockInvitationPage(
  items: ReturnType<typeof makeInvitation>[],
  total: number,
  windowMonths = 0
) {
  return {
    data: {
      success: true,
      data: {
        items,
        total,
        window_months: windowMonths,
        commission_enabled: true,
      },
    },
  }
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ReferralDetailsDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

it('lists masked invitees including those without commissions', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    mockInvitationPage(
      [makeInvitation(7, 'al***', 1000), makeInvitation(8, 'bo***', 0)],
      2
    )
  )
  renderDialog()

  expect(await screen.findByText('al***')).toBeVisible()
  expect(screen.getByText('bo***')).toBeVisible()
  expect(api.get).toHaveBeenCalledWith(
    '/api/user/self/referrals?p=1&page_size=20'
  )
  expect(document.body.textContent).toContain('2 invitees')
})

it('keeps the invitee list reachable without referral rewards', () => {
  const onViewReferrals = vi.fn()
  const user: UserWalletData = {
    id: 1,
    username: 'owner',
    quota: 0,
    used_quota: 0,
    request_count: 0,
    aff_quota: 0,
    aff_history_quota: 0,
    aff_count: 0,
    group: 'default',
  }
  render(
    <AffiliateRewardsCard
      user={user}
      affiliateLink='https://example.com/?aff=1'
      onTransfer={vi.fn()}
      onViewReferrals={onViewReferrals}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'View invitees' }))
  expect(onViewReferrals).toHaveBeenCalledTimes(1)
  expect(
    screen.queryByRole('button', { name: 'Transfer to Balance' })
  ).not.toBeInTheDocument()
})

it('shows the configured validity window when invitations never expire', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    mockInvitationPage([makeInvitation(7, 'al***', 0)], 1, -1)
  )
  renderDialog()

  expect(await screen.findByText('No expiry')).toBeVisible()
})

it('loads the next page without offering the previous one first', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(mockInvitationPage([makeInvitation(1, 'aa***', 0)], 45))
  renderDialog()
  await screen.findByText('aa***')

  expect(
    screen.getByRole('button', { name: 'Go to previous page' })
  ).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/api/user/self/referrals?p=2&page_size=20'
    )
  )
})

it('shows an error state when invitations cannot be loaded', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'))
  renderDialog()

  expect(
    await screen.findByText('Failed to load referral invitations')
  ).toBeVisible()
})
