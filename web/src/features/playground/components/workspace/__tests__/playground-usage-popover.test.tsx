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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { PlaygroundUsagePopover } from '../playground-usage-popover'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const usage = {
  group: 'pro',
  sessions: { used: 3, limit: 10, used_bytes: 0, limit_bytes: 0 },
  memories: { used: 2, limit: 100, used_bytes: 0, limit_bytes: 0 },
  attachments: {
    used: 1,
    limit: 4,
    used_bytes: 2048,
    limit_bytes: 8 * 1024 * 1024,
  },
  artifacts: { used: 0, limit: 5, used_bytes: 0, limit_bytes: 1024 },
  canvas: { used: 2, limit: 20, used_bytes: 0, limit_bytes: 0 },
  canvas_snapshots: {
    used: 5,
    limit: 200,
    used_bytes: 12 * 1024,
    limit_bytes: 64 * 1024 * 1024,
  },
  canvas_templates: {
    used: 1,
    limit: 12,
    used_bytes: 6 * 1024,
    limit_bytes: 8 * 1024 * 1024,
  },
  comparison_runs: {
    used: 2,
    limit: 30,
    used_bytes: 9 * 1024,
    limit_bytes: 16 * 1024 * 1024,
  },
  knowledge_bases: { used: 3, limit: 20, used_bytes: 0, limit_bytes: 0 },
  kb_documents: { used: 4, limit: 200, used_bytes: 0, limit_bytes: 0 },
  kb_chunks: {
    used: 12,
    limit: 10000,
    used_bytes: 24 * 1024,
    limit_bytes: 128 * 1024 * 1024,
  },
  storage: {
    used: 0,
    limit: 0,
    used_bytes: 2048,
    limit_bytes: 128 * 1024 * 1024,
  },
  tasks: { used: 1, limit: 3, used_bytes: 4096, limit_bytes: 64 * 1024 * 1024 },
}

const storageBilling = {
  enabled: true,
  group: 'pro',
  price_usd_per_gb_month: 0.015,
  free_bytes: 1024 * 1024 * 1024,
  apply_group_ratio: false,
  grace_days: 7,
  egress_mode: 'unmetered',
  egress_price_usd_per_gb: 0,
  egress_daily_bytes_limit: 0,
  egress_daily_requests_limit: 0,
  today: {
    id: 1,
    user_id: 7,
    date: '2026-10-18',
    peak_bytes: 2 * 1024 * 1024 * 1024,
    free_bytes: 1024 * 1024 * 1024,
    billable_bytes: 1024 * 1024 * 1024,
    egress_bytes: 3 * 1024 * 1024,
    egress_requests: 2,
    quota: 0,
    debt_quota: 0,
    egress_quota: 0,
    status: 'pending',
    grace_until: 0,
    settled_at: 0,
    created_at: 1,
    updated_at: 1,
  },
  debt_quota: 0,
  grace_until: 0,
  read_only: false,
}

let testI18n: i18n

function renderPopover(userId: number | null = 7, onOpenUpgrade?: () => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <PlaygroundUsagePopover userId={userId} onOpenUpgrade={onOpenUpgrade} />
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

test('opening the usage popover lists each resource against its account limit', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: usage },
  })
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(await screen.findByText('Conversations')).toBeVisible()
  expect(screen.getByText('3 of 10')).toBeVisible()
  expect(screen.getByText('Memories')).toBeVisible()
  expect(screen.getByText('2 of 100')).toBeVisible()
  expect(screen.getByText('Artifacts')).toBeVisible()
  expect(screen.getByText('0 B of 1 KiB')).toBeVisible()
  expect(screen.getByText('1 of 4')).toBeVisible()
  expect(screen.getByText('2 KiB of 8 MiB')).toBeVisible()
  expect(screen.getByText('Canvas history')).toBeVisible()
  expect(screen.getByText('5 of 200')).toBeVisible()
  expect(screen.getByText('12 KiB of 64 MiB')).toBeVisible()
  expect(screen.getByText('Canvas templates')).toBeVisible()
  expect(screen.getByText('1 of 12')).toBeVisible()
  expect(screen.getByText('Compare runs')).toBeVisible()
  expect(screen.getByText('2 of 30')).toBeVisible()
  expect(screen.getByText('9 KiB of 16 MiB')).toBeVisible()
  expect(screen.getByText('Knowledge bases')).toBeVisible()
  expect(screen.getByText('3 of 20')).toBeVisible()
  expect(screen.getByText('Knowledge base documents')).toBeVisible()
  expect(screen.getByText('4 of 200')).toBeVisible()
  expect(screen.getByText('Knowledge base chunks')).toBeVisible()
  expect(screen.getByText('12 of 10,000')).toBeVisible()
  expect(screen.getByText('24 KiB of 128 MiB')).toBeVisible()
  expect(screen.getByText('Object storage')).toBeVisible()
  expect(screen.getByText('2 KiB of 128 MiB')).toBeVisible()
  expect(screen.queryByText('0 of 0')).not.toBeInTheDocument()
  expect(screen.getByText('Tasks')).toBeVisible()
  expect(screen.getByText('1 of 3')).toBeVisible()
  expect(screen.getByText('4 KiB of 64 MiB')).toBeVisible()
  expect(api.get).toHaveBeenCalledWith(
    '/api/playground/usage',
    expect.anything()
  )
})

test('the popover names the group the limits were resolved from', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: usage },
  })
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(await screen.findByText('Current group')).toBeVisible()
  expect(screen.getByText('pro')).toBeVisible()
})

test('the upgrade entry opens the plan purchase path when provided', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: usage },
  })
  const onOpenUpgrade = vi.fn()
  const user = userEvent.setup()
  renderPopover(7, onOpenUpgrade)

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))
  await user.click(
    await screen.findByRole('button', { name: 'Upgrade for more storage' })
  )

  expect(onOpenUpgrade).toHaveBeenCalledTimes(1)
})

test('without an upgrade handler the popover offers no upgrade entry', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: usage },
  })
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(await screen.findByText('Conversations')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Upgrade for more storage' })
  ).not.toBeInTheDocument()
})

test('a failed usage request shows the error state instead of the summary', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Offline'))
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Resource usage could not be loaded.'
  )
  expect(screen.queryByText('Conversations')).not.toBeInTheDocument()
})

test('the popover shows the metered storage line while the tier is enabled', async () => {
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/api/playground/storage/billing') {
      return Promise.resolve({ data: { success: true, data: storageBilling } })
    }
    return Promise.resolve({ data: { success: true, data: usage } })
  })
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(await screen.findByText('Storage billing')).toBeVisible()
  expect(screen.getByText('Peak stored today')).toBeVisible()
  expect(screen.getByText('2 GiB')).toBeVisible()
  expect(screen.getByText('Downloaded today')).toBeVisible()
  expect(screen.getByText('3 MiB')).toBeVisible()
})

test('an unpaid storage day marks the popover read-only', async () => {
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/api/playground/storage/billing') {
      return Promise.resolve({
        data: {
          success: true,
          data: { ...storageBilling, debt_quota: 500000, read_only: true },
        },
      })
    }
    return Promise.resolve({ data: { success: true, data: usage } })
  })
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(
    await screen.findByText(
      'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.'
    )
  ).toBeVisible()
})

test('a disabled storage tier leaves the popover unchanged', async () => {
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url === '/api/playground/storage/billing') {
      return Promise.resolve({
        data: { success: true, data: { ...storageBilling, enabled: false } },
      })
    }
    return Promise.resolve({ data: { success: true, data: usage } })
  })
  const user = userEvent.setup()
  renderPopover()

  await user.click(screen.getByRole('button', { name: 'Resource usage' }))

  expect(await screen.findByText('Conversations')).toBeVisible()
  expect(screen.queryByText('Storage billing')).not.toBeInTheDocument()
})
