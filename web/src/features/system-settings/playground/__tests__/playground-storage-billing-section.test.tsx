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
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { PlaygroundStorageBillingSection } from '../playground-storage-billing-section'

type OptionBody = { key: string; value: string }

function bodyFor(key: string): OptionBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => call[1] as OptionBody)
    .find((body) => body.key === key)
}

function Fixture(props: { storageBillingJson: string }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <PlaygroundStorageBillingSection
          storageBillingJson={props.storageBillingJson}
        />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(storageBilling?: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture storageBillingJson={JSON.stringify(storageBilling ?? {})} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('enabling the tier saves the full policy JSON under the storage key', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.click(
    screen.getByRole('switch', { name: 'Enable metered storage billing' })
  )
  const price = screen.getByRole('spinbutton', {
    name: 'Storage price per GB-month (USD)',
  })
  fireEvent.change(price, { target: { value: '0.02' } })
  await user.click(screen.getByRole('button', { name: 'Save storage billing' }))

  await waitFor(() =>
    expect(bodyFor('playground_setting.storage_billing')).toBeDefined()
  )
  const body = bodyFor('playground_setting.storage_billing')
  expect(JSON.parse(body?.value ?? '{}')).toEqual({
    enabled: true,
    price_usd_per_gb_month: 0.02,
    free_gb: 1,
    group_free_gb: {},
    apply_group_ratio: false,
    grace_days: 7,
    egress: {
      mode: 'unmetered',
      price_usd_per_gb: 0,
      daily_bytes_limit: 0,
      daily_requests_limit: 0,
    },
  })
})

test('a group override keeps its own free allowance', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.type(screen.getByPlaceholderText('Enter a group name'), 'pro')
  await user.click(screen.getByRole('button', { name: 'Add group' }))
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Free allowance (GB)' }),
    { target: { value: '5' } }
  )
  await user.click(screen.getByRole('button', { name: 'Save storage billing' }))

  await waitFor(() =>
    expect(bodyFor('playground_setting.storage_billing')).toBeDefined()
  )
  const body = bodyFor('playground_setting.storage_billing')
  expect(JSON.parse(body?.value ?? '{}')).toMatchObject({
    group_free_gb: { pro: 5 },
  })
})

test('a metered egress policy round-trips through the saved JSON', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.click(screen.getByRole('combobox', { name: 'Egress mode' }))
  await user.click(await screen.findByRole('option', { name: 'Metered' }))
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Egress price per GB (USD)' }),
    { target: { value: '0.05' } }
  )
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Daily download limit (bytes)' }),
    { target: { value: '1073741824' } }
  )
  await user.click(screen.getByRole('button', { name: 'Save storage billing' }))

  await waitFor(() =>
    expect(bodyFor('playground_setting.storage_billing')).toBeDefined()
  )
  const body = bodyFor('playground_setting.storage_billing')
  expect(JSON.parse(body?.value ?? '{}')).toMatchObject({
    egress: {
      mode: 'metered',
      price_usd_per_gb: 0.05,
      daily_bytes_limit: 1073741824,
    },
  })
})

test('a negative grace period blocks saving and shows a field error', async () => {
  renderSection()

  const grace = screen.getByRole('spinbutton', {
    name: 'Grace period (days)',
  })
  fireEvent.change(grace, { target: { value: '-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save storage billing' }))

  await waitFor(() => expect(grace).toHaveAttribute('aria-invalid', 'true'))
  expect(screen.getByText('Enter a non-negative whole number.')).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('an unchanged policy is not saved again', async () => {
  renderSection({
    enabled: true,
    price_usd_per_gb_month: 0.02,
    free_gb: 1,
    group_free_gb: {},
    apply_group_ratio: false,
    grace_days: 7,
    egress: {
      mode: 'unmetered',
      price_usd_per_gb: 0,
      daily_bytes_limit: 0,
      daily_requests_limit: 0,
    },
  })

  fireEvent.click(screen.getByRole('button', { name: 'Save storage billing' }))

  await waitFor(() => expect(api.put).not.toHaveBeenCalled())
})
