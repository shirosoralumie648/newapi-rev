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
import { CreditGrantValiditySection } from '../credit-grant-validity-section'

type OptionBody = { key: string; value: string | number }

function bodyFor(key: string): OptionBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => call[1] as OptionBody)
    .find((body) => body.key === key)
}

type SectionProps = {
  defaultDays: number | string
  sourceExpiryDays: Record<string, number>
}

function Fixture(props: SectionProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <CreditGrantValiditySection
          defaultDays={props.defaultDays}
          sourceExpiryDaysJson={JSON.stringify(props.sourceExpiryDays)}
        />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(
  defaultDays: number | string = 0,
  sourceExpiryDays: Record<string, number> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture defaultDays={defaultDays} sourceExpiryDays={sourceExpiryDays} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('editing the default validity saves it in days', async () => {
  const user = userEvent.setup()
  renderSection(0)

  const days = screen.getByRole('spinbutton', {
    name: 'Default validity (days)',
  })
  expect(days).toHaveValue(0)
  fireEvent.change(days, { target: { value: '90' } })
  await user.click(
    screen.getByRole('button', { name: 'Save credit grant validity' })
  )

  await waitFor(() =>
    expect(bodyFor('credit_grant_setting.default_expiry_days')).toEqual({
      key: 'credit_grant_setting.default_expiry_days',
      value: '90',
    })
  )
  expect(bodyFor('credit_grant_setting.source_expiry_days')).toBeUndefined()
})

test('a per-source override is saved as one map and can be removed', async () => {
  const user = userEvent.setup()
  renderSection(0, { checkin: 7 })

  expect(screen.getByDisplayValue('Check-in')).toBeVisible()
  const sourceDays = screen.getByDisplayValue('7')
  fireEvent.change(sourceDays, { target: { value: '14' } })

  await user.click(
    screen.getByRole('button', { name: 'Save credit grant validity' })
  )

  await waitFor(() =>
    expect(bodyFor('credit_grant_setting.source_expiry_days')).toBeDefined()
  )
  expect(
    JSON.parse(
      String(bodyFor('credit_grant_setting.source_expiry_days')?.value)
    )
  ).toEqual({ checkin: 14 })
  expect(bodyFor('credit_grant_setting.default_expiry_days')).toBeUndefined()

  // Removing the override clears it again.
  await user.click(screen.getByRole('button', { name: 'Remove' }))
  expect(screen.queryByDisplayValue('Check-in')).toBeNull()
  await user.click(
    screen.getByRole('button', { name: 'Save credit grant validity' })
  )
  await waitFor(() =>
    expect(
      String(bodyFor('credit_grant_setting.source_expiry_days')?.value)
    ).toBe('{}')
  )
})

test('an out-of-range validity blocks saving and marks the field invalid', async () => {
  renderSection(0)

  const days = screen.getByRole('spinbutton', {
    name: 'Default validity (days)',
  })
  fireEvent.change(days, { target: { value: '9999' } })
  fireEvent.click(
    screen.getByRole('button', { name: 'Save credit grant validity' })
  )

  await waitFor(() => expect(days).toHaveAttribute('aria-invalid', 'true'))
  expect(
    screen.getByText('Expiry must be a whole number of days between 0 and 3650')
  ).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})
