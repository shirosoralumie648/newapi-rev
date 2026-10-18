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
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'

import { PlaygroundStorageLedgerDialog } from '../playground-storage-ledger-dialog'

const i18n = createInstance()

function makeDay(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    user_id: 7,
    date: '2026-10-17',
    peak_bytes: 2147483648,
    free_bytes: 1073741824,
    billable_bytes: 1073741824,
    egress_bytes: 0,
    egress_requests: 0,
    quota: 100000,
    debt_quota: 25000,
    egress_quota: 0,
    status: 'grace',
    grace_until: 1700000000,
    settled_at: 1700000000,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  }
}

function mockLedgerPage(items: ReturnType<typeof makeDay>[], total: number) {
  return { data: { success: true, data: { items, total } } }
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PlaygroundStorageLedgerDialog open onOpenChange={vi.fn()} />
      </I18nextProvider>
    </QueryClientProvider>
  )
}

beforeEach(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    fallbackLng: false,
    nsSeparator: false,
    resources: { en, zh },
    interpolation: { escapeValue: false },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('renders one storage day with its translated status', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(mockLedgerPage([makeDay()], 1))
  renderDialog()

  expect(await screen.findByText('2026-10-17')).toBeVisible()
  expect(screen.getByText('#7')).toBeVisible()
  expect(screen.getByText(i18n.t('Grace'))).toBeVisible()
})

it('shows the empty state and disables export when the ledger has no entries', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(mockLedgerPage([], 0))
  renderDialog()

  await screen.findByText(i18n.t('No storage ledger entries found'))
  expect(
    screen.getByText(i18n.t('Daily storage charges will appear here'))
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: i18n.t('Export CSV') })
  ).toBeDisabled()
})

it('reports a matching wallet ledger after reconciliation', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(mockLedgerPage([makeDay()], 1))
  renderDialog()
  await screen.findByText('2026-10-17')

  get.mockResolvedValueOnce({
    data: {
      success: true,
      data: {
        checked_at: 1700000000,
        user_count: 3,
        deviation_count: 0,
        deviations: [],
      },
    },
  })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('Reconcile') }))

  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('/api/user/playground/storage/reconcile')
    )
  )
  expect(
    await screen.findByText(i18n.t('Storage charges match the wallet ledger.'))
  ).toBeVisible()
})
