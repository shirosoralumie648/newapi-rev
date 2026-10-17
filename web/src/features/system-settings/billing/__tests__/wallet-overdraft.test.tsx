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
import { WalletOverdraftSection } from '../wallet-overdraft-section'

type OptionBody = { key: string; value: string | number }

function bodyFor(key: string): OptionBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => call[1] as OptionBody)
    .find((body) => body.key === key)
}

type SectionProps = { defaultUsd: number; groupOverridesJson: string }

function Fixture(props: SectionProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <WalletOverdraftSection
          defaultUsd={props.defaultUsd}
          groupOverridesJson={props.groupOverridesJson}
        />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(defaultUsd = 0, overrides: Record<string, number> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture
        defaultUsd={defaultUsd}
        groupOverridesJson={JSON.stringify(overrides)}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('editing the global credit line saves it in USD', async () => {
  const user = userEvent.setup()
  renderSection(0)

  const limit = screen.getByRole('spinbutton', {
    name: 'Wallet overdraft limit (USD)',
  })
  expect(limit).toHaveValue(0)
  fireEvent.change(limit, { target: { value: '0.02' } })
  await user.click(
    screen.getByRole('button', { name: 'Save wallet overdraft' })
  )

  await waitFor(() =>
    expect(bodyFor('quota_setting.overdraft_limit_usd')).toEqual({
      key: 'quota_setting.overdraft_limit_usd',
      value: '0.02',
    })
  )
  expect(bodyFor('quota_setting.overdraft_group_overrides')).toBeUndefined()
})

test('adding a group override saves the whole override map', async () => {
  const user = userEvent.setup()
  renderSection(0.01, { alpha: 0.5 })

  expect(screen.getByDisplayValue('alpha')).toBeVisible()
  const overrideInput = screen.getByDisplayValue('0.5')
  fireEvent.change(overrideInput, { target: { value: '0.75' } })

  await user.type(screen.getByPlaceholderText('Enter a group name'), 'beta')
  await user.click(screen.getByRole('button', { name: 'Add group' }))
  expect(screen.getByDisplayValue('beta')).toBeVisible()

  await user.click(
    screen.getByRole('button', { name: 'Save wallet overdraft' })
  )

  await waitFor(() =>
    expect(bodyFor('quota_setting.overdraft_group_overrides')).toBeDefined()
  )
  expect(
    JSON.parse(
      String(bodyFor('quota_setting.overdraft_group_overrides')?.value)
    )
  ).toEqual({ alpha: 0.75, beta: 0 })
  expect(bodyFor('quota_setting.overdraft_limit_usd')).toBeUndefined()
})

test('a negative credit line blocks saving and marks the field invalid', async () => {
  renderSection(0.01)

  const limit = screen.getByRole('spinbutton', {
    name: 'Wallet overdraft limit (USD)',
  })
  fireEvent.change(limit, { target: { value: '-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save wallet overdraft' }))

  await waitFor(() => expect(limit).toHaveAttribute('aria-invalid', 'true'))
  expect(screen.getByText('Must be greater than or equal to 0')).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})
