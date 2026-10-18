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
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { CreditGrantDialog } from '@/features/wallet/components/dialogs/credit-grant-dialog'
import { api } from '@/lib/api'
import { formatQuota } from '@/lib/format'

const WALLET = {
  user_id: 9,
  total_quota: 900,
  paid_quota: 300,
  grant_quota: 600,
  expired_quota: 0,
  grants: [
    {
      grant_id: 21,
      source: 'redeem',
      remaining: 600,
      expires_at: 1_700_003_600,
      created_at: 1_700_000_000,
    },
  ],
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
      <CreditGrantDialog
        open
        onOpenChange={vi.fn()}
        userId={9}
        username='grant-user'
      />
    </QueryClientProvider>
  )
}

test('lists the buckets of the account with their source and validity', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(respond({ success: true, data: WALLET }))
  renderDialog()

  expect(await screen.findByText('Redeem')).toBeVisible()
  // The bucket remainder and the granted total both show 600.
  expect(screen.getAllByText(formatQuota(600)).length).toBeGreaterThan(0)
  expect(screen.getByText(formatQuota(300))).toBeVisible()
  expect(screen.getByText('Credit grants of grant-user')).toBeVisible()
  expect(get).toHaveBeenCalledWith('/api/user/9/wallet/grants')
})

test('issues a grant with the entered quota and validity', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: WALLET })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  await screen.findByText('Redeem')
  fireEvent.change(screen.getByLabelText('Quota'), {
    target: { value: '500' },
  })
  fireEvent.change(screen.getByLabelText('Expires in days'), {
    target: { value: '30' },
  })
  fireEvent.change(screen.getByLabelText('Note'), {
    target: { value: 'support credit' },
  })
  await user.click(screen.getByRole('button', { name: 'Issue credit grant' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/wallet/grants', {
      user_id: 9,
      source: 'gift',
      quota: 500,
      expires_in_days: 30,
      note: 'support credit',
    })
  )
})

test('refuses a non-positive quota without calling the API', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: WALLET })
  )
  const post = vi.spyOn(api, 'post')
  renderDialog()

  await screen.findByText('Redeem')
  fireEvent.change(screen.getByLabelText('Quota'), {
    target: { value: '0' },
  })
  await user.click(screen.getByRole('button', { name: 'Issue credit grant' }))

  expect(
    await screen.findByText('Quota must be a positive integer')
  ).toBeVisible()
  expect(post).not.toHaveBeenCalled()
})
