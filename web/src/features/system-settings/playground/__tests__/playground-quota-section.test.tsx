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
import { PlaygroundQuotaSection } from '../playground-quota-section'

type OptionBody = { key: string; value: string }

function bodyFor(key: string): OptionBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => call[1] as OptionBody)
    .find((body) => body.key === key)
}

type SectionProps = { defaultsJson: string; groupOverridesJson: string }

function Fixture(props: SectionProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <PlaygroundQuotaSection
          defaultsJson={props.defaultsJson}
          groupOverridesJson={props.groupOverridesJson}
        />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(
  defaults: Record<string, number>,
  overrides: Record<string, Record<string, number>> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture
        defaultsJson={JSON.stringify(defaults)}
        groupOverridesJson={JSON.stringify(overrides)}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('editing a global default saves the full defaults policy with the changed value', async () => {
  const user = userEvent.setup()
  renderSection({ session_max_count: 100, message_max_count: 50 })

  const messages = screen.getByRole('spinbutton', {
    name: 'Messages per conversation',
  })
  expect(messages).toHaveValue(50)
  fireEvent.change(messages, { target: { value: '60' } })
  await user.click(
    screen.getByRole('button', { name: 'Save Playground quotas' })
  )

  await waitFor(() =>
    expect(bodyFor('playground_setting.defaults')).toBeDefined()
  )
  const body = bodyFor('playground_setting.defaults')
  expect(JSON.parse(body?.value ?? '{}')).toMatchObject({
    session_max_count: 100,
    message_max_count: 60,
  })
  expect(bodyFor('playground_setting.group_overrides')).toBeUndefined()
})

test('editing a group override saves only the group policy and keeps inherited fields out', async () => {
  const user = userEvent.setup()
  renderSection({ session_max_count: 100 }, { alpha: { session_max_count: 5 } })

  expect(screen.getByText('alpha')).toBeVisible()
  const overrideMessages = screen.getAllByRole('spinbutton', {
    name: 'Messages per conversation',
  })[1]
  fireEvent.change(overrideMessages, { target: { value: '25' } })
  await user.click(
    screen.getByRole('button', { name: 'Save Playground quotas' })
  )

  await waitFor(() =>
    expect(bodyFor('playground_setting.group_overrides')).toBeDefined()
  )
  const body = bodyFor('playground_setting.group_overrides')
  expect(JSON.parse(body?.value ?? '{}')).toEqual({
    alpha: { session_max_count: 5, message_max_count: 25 },
  })
  expect(bodyFor('playground_setting.defaults')).toBeUndefined()
})

test('a non-positive global default blocks saving and shows a field error', async () => {
  renderSection({ session_max_count: 100 })

  const sessions = screen.getByRole('spinbutton', {
    name: 'Conversations per user',
  })
  fireEvent.change(sessions, { target: { value: '0' } })
  fireEvent.click(
    screen.getByRole('button', { name: 'Save Playground quotas' })
  )

  await waitFor(() => expect(sessions).toHaveAttribute('aria-invalid', 'true'))
  expect(screen.getByText('Enter a positive whole number.')).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('adding and removing a group override changes the editable list without saving', async () => {
  const user = userEvent.setup()
  renderSection({})

  await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'beta')
  await user.click(screen.getByRole('button', { name: 'Add group override' }))
  expect(screen.getByText('beta')).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Remove' }))
  expect(screen.queryByText('beta')).not.toBeInTheDocument()
  expect(api.put).not.toHaveBeenCalled()
})

test('a group override can grant a larger object storage entitlement', async () => {
  const user = userEvent.setup()
  renderSection(
    { object_user_max_bytes: 1024 },
    { pro: { session_max_count: 5 } }
  )

  const storage = screen.getAllByRole('spinbutton', {
    name: 'Object storage per user',
  })[1]
  expect(storage).toHaveValue(1024)
  fireEvent.change(storage, { target: { value: String(16 * 1024 * 1024) } })
  await user.click(
    screen.getByRole('button', { name: 'Save Playground quotas' })
  )

  await waitFor(() =>
    expect(bodyFor('playground_setting.group_overrides')).toBeDefined()
  )
  expect(
    JSON.parse(bodyFor('playground_setting.group_overrides')?.value ?? '{}')
  ).toEqual({
    pro: { session_max_count: 5, object_user_max_bytes: 16 * 1024 * 1024 },
  })
  expect(bodyFor('playground_setting.defaults')).toBeUndefined()
})
