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
import { ReferralCommissionSection } from '../referral-commission-section'

type OptionBody = { key: string; value: string | number }

function bodyFor(key: string): OptionBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => call[1] as OptionBody)
    .find((body) => body.key === key)
}

type SectionProps = Parameters<typeof ReferralCommissionSection>[0]

const DEFAULT_PROPS: SectionProps = {
  enabled: false,
  commissionRatePercent: 0,
  groupRateOverridesJson: '{}',
  windowMonths: 12,
  includeRedemptionCodes: false,
  cashSettlementEnabled: false,
  inviteLimitPerIp: 0,
  inviteLimitPerDevice: 0,
  inviteLimitPerEmailDomain: 0,
  dailyCommissionCapUsd: 0,
  monthlyCommissionCapUsd: 0,
  inviteeCommissionCapUsd: 0,
  reviewThresholdUsd: 0,
  requireRealName: false,
  complianceConfirmed: true,
}

function Fixture(props: SectionProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <ReferralCommissionSection {...props} />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(overrides: Partial<SectionProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture {...DEFAULT_PROPS} {...overrides} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('editing the commission rate saves it in percent', async () => {
  const user = userEvent.setup()
  renderSection()

  const rate = screen.getByRole('spinbutton', {
    name: 'Commission rate (percent)',
  })
  fireEvent.change(rate, { target: { value: '12.5' } })
  await user.click(
    screen.getByRole('button', { name: 'Save referral commission' })
  )

  await waitFor(() =>
    expect(bodyFor('referral_setting.commission_rate_percent')).toEqual({
      key: 'referral_setting.commission_rate_percent',
      value: '12.5',
    })
  )
  expect(bodyFor('referral_setting.window_months')).toBeUndefined()
})

test('a rate above 100 blocks saving and marks the field invalid', async () => {
  renderSection()

  const rate = screen.getByRole('spinbutton', {
    name: 'Commission rate (percent)',
  })
  fireEvent.change(rate, { target: { value: '150' } })
  fireEvent.click(
    screen.getByRole('button', { name: 'Save referral commission' })
  )

  await waitFor(() => expect(rate).toHaveAttribute('aria-invalid', 'true'))
  expect(screen.getByText('Must be a rate between 0 and 100')).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('an invitation limit above the maximum blocks saving', async () => {
  renderSection()

  const limit = screen.getByRole('spinbutton', {
    name: 'Invite limit per IP',
  })
  fireEvent.change(limit, { target: { value: '101' } })
  fireEvent.click(
    screen.getByRole('button', { name: 'Save referral commission' })
  )

  await waitFor(() => expect(limit).toHaveAttribute('aria-invalid', 'true'))
  expect(
    screen.getByText('Must be a whole number between 0 and 100')
  ).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('adding a group override saves the whole override map', async () => {
  const user = userEvent.setup()
  renderSection({
    commissionRatePercent: 10,
    groupRateOverridesJson: '{"vip":20}',
  })

  expect(screen.getByDisplayValue('vip')).toBeVisible()
  const overrideInput = screen.getByDisplayValue('20')
  fireEvent.change(overrideInput, { target: { value: '25' } })

  await user.type(screen.getByPlaceholderText('Enter a group name'), 'partner')
  await user.click(screen.getByRole('button', { name: 'Add group' }))
  expect(screen.getByDisplayValue('partner')).toBeVisible()

  await user.click(
    screen.getByRole('button', { name: 'Save referral commission' })
  )

  await waitFor(() =>
    expect(bodyFor('referral_setting.group_rate_overrides')).toBeDefined()
  )
  expect(
    JSON.parse(String(bodyFor('referral_setting.group_rate_overrides')?.value))
  ).toEqual({ partner: 0, vip: 25 })
  expect(bodyFor('referral_setting.commission_rate_percent')).toBeUndefined()
})

test('the engine and cash settlement require the confirmed compliance terms', () => {
  renderSection({ complianceConfirmed: false })

  // Base UI renders the switch as a span with role="switch"; its disabled
  // state is exposed through aria-disabled rather than the native attribute.
  expect(
    screen.getByRole('switch', { name: 'Enable referral commission' })
  ).toHaveAttribute('aria-disabled', 'true')
  expect(
    screen.getByRole('switch', { name: 'Cash settlement' })
  ).toHaveAttribute('aria-disabled', 'true')
})

test('the engine switch is enabled once compliance is confirmed', () => {
  renderSection({ complianceConfirmed: true })

  expect(
    screen.getByRole('switch', { name: 'Enable referral commission' })
  ).not.toHaveAttribute('aria-disabled', 'true')
})
