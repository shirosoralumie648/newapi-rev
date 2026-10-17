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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { WalletLedgerDialog } from '@/features/wallet/components/dialogs/wallet-ledger-dialog'
import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'

const i18n = createInstance()

type Download = { filename: string; blob: Blob }

function makeEntry(id: number, kind: string, amount: number) {
  return {
    id,
    user_id: 7,
    kind,
    amount,
    balance_after: 1000 + id,
    ref_type: 'topup',
    ref_id: `ref-${id}`,
    created_at: 1700000000 + id,
  }
}

function mockLedgerPage(items: ReturnType<typeof makeEntry>[], total: number) {
  return { data: { success: true, data: { items, total } } }
}

function renderDialog(props: { userId?: number; username?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <WalletLedgerDialog open onOpenChange={vi.fn()} {...props} />
      </I18nextProvider>
    </QueryClientProvider>
  )
}

function captureDownloads(): Download[] {
  const downloads: Download[] = []
  let currentBlob: Blob
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        currentBlob = blob
        return 'blob:wallet-ledger'
      }),
      revokeObjectURL: vi.fn(),
    })
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      downloads.push({ filename: this.download, blob: currentBlob })
    }
  )
  return downloads
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

it('translates wallet ledger kinds and updates them when the language changes', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    mockLedgerPage(
      [makeEntry(1, 'topup', 500), makeEntry(2, 'consume_hourly', -60)],
      2
    )
  )
  renderDialog()
  await screen.findByText('ref-1')
  expect(screen.getByText('充值')).toBeVisible()
  expect(screen.getByText('按小时消费')).toBeVisible()

  await act(() => i18n.changeLanguage('en'))
  expect(screen.getByText('Top-up')).toBeVisible()
  expect(screen.getByText('Hourly Consumption')).toBeVisible()
})

it('shows the empty state and disables export when the ledger has no entries', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(mockLedgerPage([], 0))
  renderDialog()
  await screen.findByText(i18n.t('No ledger entries found'))
  expect(
    screen.getByRole('button', { name: i18n.t('Export CSV') })
  ).toBeDisabled()
})

it('loads the next page without offering the previous page on the first one', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(mockLedgerPage([makeEntry(1, 'topup', 500)], 45))
  renderDialog()
  await screen.findByText('ref-1')
  expect(get).toHaveBeenCalledWith(
    expect.stringContaining('/api/user/self/wallet/ledger?p=1&page_size=20')
  )
  expect(
    screen.getByRole('button', { name: i18n.t('Go to previous page') })
  ).toBeDisabled()

  fireEvent.click(
    screen.getByRole('button', { name: i18n.t('Go to next page') })
  )
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('/api/user/self/wallet/ledger?p=2&page_size=20')
    )
  )
})

it('downloads the ledger CSV from the export endpoint', async () => {
  const downloads = captureDownloads()
  const get = vi.spyOn(api, 'get')
  get.mockResolvedValue(mockLedgerPage([makeEntry(1, 'topup', 500)], 1))
  renderDialog()
  await screen.findByText('ref-1')

  get.mockResolvedValueOnce({
    data: new Blob(['id,kind\n1,topup\n'], { type: 'text/csv' }),
  })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('Export CSV') }))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/user/self/wallet/ledger/export', {
      responseType: 'blob',
    })
  )
  await waitFor(() => expect(downloads).toHaveLength(1))
  expect(downloads[0].filename).toBe('wallet-ledger.csv')
  expect(downloads[0].blob.type).toBe('text/csv')
})

it('loads the selected user ledger in the admin view', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(mockLedgerPage([makeEntry(1, 'admin_adjust', -200)], 1))
  renderDialog({ userId: 42, username: 'alice' })
  await screen.findByText('ref-1')
  expect(get).toHaveBeenCalledWith(
    expect.stringContaining('/api/user/42/wallet/ledger?p=1&page_size=20')
  )
  expect(
    screen.getByText(
      i18n.t('Wallet ledger of {{username}}', { username: 'alice' })
    )
  ).toBeVisible()
})
