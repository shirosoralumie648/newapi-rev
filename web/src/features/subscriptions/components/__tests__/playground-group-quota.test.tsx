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
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { PlaygroundGroupQuotaEditor } from '../playground-group-quota'

type OptionBody = { key: string; value: string }

function optionsResponse(overrides: Record<string, Record<string, number>>) {
  return {
    data: {
      success: true,
      message: 'success',
      data: [
        {
          key: 'playground_setting.group_overrides',
          value: JSON.stringify(overrides),
        },
      ],
    },
  }
}

function savedBody(): OptionBody | undefined {
  return vi.mocked(api.put).mock.calls[0]?.[1] as OptionBody | undefined
}

let testI18n: i18n

function renderEditor(onConfigure?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <PlaygroundGroupQuotaEditor group='pro' onConfigure={onConfigure} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

test('editing the upgrade group storage budget saves a merged override map', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    optionsResponse({
      basic: { attachment_user_max_bytes: 2048 },
      pro: { session_max_count: 5, object_user_max_bytes: 1024 },
    })
  )
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderEditor()

  // The storage budgets of the group are the entitlement the plan sells.
  expect(
    await screen.findByRole('spinbutton', {
      name: /Attachment storage per user/,
    })
  ).toBeVisible()
  expect(
    screen.getByRole('spinbutton', { name: /Artifact storage per user/ })
  ).toBeVisible()
  expect(
    screen.getByRole('spinbutton', { name: /Canvas storage per user/ })
  ).toBeVisible()
  expect(
    screen.getByRole('spinbutton', { name: /Task result storage per user/ })
  ).toBeVisible()
  const storage = screen.getByRole('spinbutton', {
    name: /Object storage per user/,
  })
  expect(storage).toHaveValue(1024)

  fireEvent.change(storage, { target: { value: String(8 * 1024 * 1024) } })
  await user.click(screen.getByRole('button', { name: 'Save storage quota' }))

  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
  expect(savedBody()?.key).toBe('playground_setting.group_overrides')
  expect(JSON.parse(savedBody()?.value ?? '{}')).toEqual({
    basic: { attachment_user_max_bytes: 2048 },
    pro: { session_max_count: 5, object_user_max_bytes: 8 * 1024 * 1024 },
  })
})

test('a non-positive storage budget blocks the save and marks the field', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(optionsResponse({}))
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
  renderEditor()

  const storage = await screen.findByRole('spinbutton', {
    name: /Object storage per user/,
  })
  fireEvent.change(storage, { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save storage quota' }))

  await waitFor(() => expect(storage).toHaveAttribute('aria-invalid', 'true'))
  expect(screen.getByText('Enter a positive whole number.')).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('saving without edits leaves the stored override map untouched', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    optionsResponse({ pro: { object_user_max_bytes: 1024 } })
  )
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
  const user = userEvent.setup()
  renderEditor()

  const storage = await screen.findByRole('spinbutton', {
    name: /Object storage per user/,
  })
  expect(storage).toHaveValue(1024)
  await user.click(screen.getByRole('button', { name: 'Save storage quota' }))

  expect(api.put).not.toHaveBeenCalled()
})

test('a failed options request shows the fallback and still offers the configuration entry', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Forbidden'))
  const onConfigure = vi.fn()
  const user = userEvent.setup()
  renderEditor(onConfigure)

  expect(
    await screen.findByText('Playground resource quotas could not be loaded.')
  ).toBeVisible()
  await user.click(
    screen.getByRole('button', { name: 'Open Playground resource quotas' })
  )
  expect(onConfigure).toHaveBeenCalledTimes(1)
})
