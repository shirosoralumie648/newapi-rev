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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { ReferralProfileDialog } from '@/features/wallet/components/dialogs/referral-profile-dialog'
import { api } from '@/lib/api'
import { formatQuota } from '@/lib/format'

const PROFILE = {
  user_id: 9,
  signal: {
    id: 1,
    user_id: 9,
    ip: '203.0.113.9',
    device_hash: 'abcdef0123456789',
    email_domain: 'example.com',
    user_agent: 'referral-test-agent/1.0',
    created_at: 1_700_000_000,
  },
  identity_linked: true,
  identity_ref: 'deadbeef',
  flag: {
    id: 5,
    user_id: 9,
    level: 'watch',
    note: 'suspicious invitations',
    marked_by: 1,
    created_at: 1,
    updated_at: 2,
  },
  invitees: 3,
  commissions: [
    { status: 'pending', count: 2, quota: 1000 },
    { status: 'blocked', count: 1, quota: 500 },
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
      <ReferralProfileDialog
        open
        onOpenChange={vi.fn()}
        userId={9}
        username='profile-user'
      />
    </QueryClientProvider>
  )
}

test('shows the registration environment, identity and commission history', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(respond({ success: true, data: PROFILE }))
  renderDialog()

  expect(
    await screen.findByText(
      'Registration environment and rewards of profile-user'
    )
  ).toBeVisible()
  expect(screen.getByText('203.0.113.9')).toBeVisible()
  expect(screen.getByText('example.com')).toBeVisible()
  expect(screen.getByText('referral-test-agent/1.0')).toBeVisible()
  expect(screen.getByText('Identity reference: deadbeef')).toBeVisible()
  expect(screen.getByText('Invitees: 3')).toBeVisible()
  expect(screen.getByText('Current mark: Watch')).toBeVisible()
  expect(screen.getByText('Pending')).toBeVisible()
  expect(screen.getByText('Blocked')).toBeVisible()
  expect(screen.getByText(formatQuota(1000))).toBeVisible()
  expect(get).toHaveBeenCalledWith('/api/user/9/referral-profile')
})

test('saves the anti-abuse mark with its level and note', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: PROFILE })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  const note = await screen.findByLabelText('Note')
  fireEvent.change(note, { target: { value: 'manual review requested' } })
  await user.click(screen.getByRole('button', { name: 'Save mark' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/9/referral-flag', {
      level: 'watch',
      note: 'manual review requested',
    })
  )
})

test('records the verified identity as a hash', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: PROFILE })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  const identity = await screen.findByLabelText('Verified identity')
  fireEvent.change(identity, { target: { value: 'ID-123-456' } })
  await user.click(screen.getByRole('button', { name: 'Record identity' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/api/user/9/referral-identity', {
      identity: 'ID-123-456',
    })
  )
})

test('refuses an empty identity without calling the API', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: PROFILE })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  await screen.findByLabelText('Verified identity')
  await user.click(screen.getByRole('button', { name: 'Record identity' }))

  expect(await screen.findByText('Enter the verified identity')).toBeVisible()
  expect(post).not.toHaveBeenCalled()
})

test('clears the recorded identity after confirmation', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue(
    respond({ success: true, data: PROFILE })
  )
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue(respond({ success: true }))
  renderDialog()

  await screen.findByText('Identity reference: deadbeef')
  await user.click(screen.getByRole('button', { name: 'Clear identity' }))

  const confirm = await screen.findByRole('alertdialog')
  await user.click(
    within(confirm).getByRole('button', { name: 'Clear identity' })
  )

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith('/api/user/9/referral-identity')
  )
})
