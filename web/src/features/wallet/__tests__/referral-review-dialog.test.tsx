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
import { expect, test, vi } from 'vitest'

import { ReferralReviewDialog } from '@/features/wallet/components/dialogs/referral-review-dialog'
import { api } from '@/lib/api'
import { formatQuota } from '@/lib/format'

const REVIEW = {
  id: 11,
  inviter_id: 2,
  invitee_id: 9,
  source: 'code',
  ref_type: 'topup',
  ref_id: 'review-order',
  base_quota: 500000,
  rate_percent: '10',
  commission_quota: 50000,
  status: 'review',
  reason: 'review_threshold',
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
}

/** api.get resolves an AxiosResponse; only the payload matters here. */
function respond(data: unknown): never {
  return { data } as never
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ReferralReviewDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>
  )
}

test('lists a pending review with its amount and reason', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue(
    respond({
      success: true,
      data: { items: [REVIEW], total: 1 },
    })
  )
  renderDialog()

  expect(await screen.findByText('#11')).toBeVisible()
  expect(screen.getByText('#9')).toBeVisible()
  expect(screen.getByText('Invitation Code')).toBeVisible()
  expect(screen.getByText(formatQuota(50000))).toBeVisible()
  expect(screen.getByText('Above the review threshold')).toBeVisible()
  expect(get).toHaveBeenCalledWith(
    '/api/user/referral/reviews?p=1&page_size=20'
  )
})

test('approves a reviewed commission', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: { items: [REVIEW], total: 1 } })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  await screen.findByText('#11')
  await user.click(screen.getByRole('button', { name: 'Approve' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/referral/reviews/11', {
      decision: 'approve',
    })
  )
})

test('rejects a reviewed commission', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: { items: [REVIEW], total: 1 } })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  await screen.findByText('#11')
  await user.click(screen.getByRole('button', { name: 'Reject' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/referral/reviews/11', {
      decision: 'reject',
    })
  )
})

test('shows the empty state when nothing waits for review', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: { items: [], total: 0 } })
  )
  renderDialog()

  expect(
    await screen.findByText('No commissions are waiting for review')
  ).toBeVisible()
})
