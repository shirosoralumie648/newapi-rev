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

import { ReferralAdminDialog } from '@/features/wallet/components/dialogs/referral-admin-dialog'
import { EMPTY_REFERRAL_STATS_SUMMARY } from '@/features/wallet/lib'
import type {
  ReferralInvitation,
  ReferralStatsSummary,
} from '@/features/wallet/types'
import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'
import { api } from '@/lib/api'
import { formatQuota } from '@/lib/format'

const i18n = createInstance()

type Download = { filename: string; blob: Blob }

function makeInvitation(
  overrides: Partial<ReferralInvitation> = {}
): ReferralInvitation {
  return {
    invitee_id: 7,
    username: 'invitee-7',
    email: 'invitee-7@example.com',
    inviter_id: 1,
    inviter_username: 'owner',
    source: 'link',
    bound_at: 1700000000,
    commission_ends_at: 0,
    pending_quota: 0,
    locked_quota: 0,
    settled_quota: 0,
    refunded_quota: 0,
    review_quota: 0,
    blocked_quota: 0,
    rejected_quota: 0,
    total_paid_quota: 0,
    commission_count: 0,
    ...overrides,
  }
}

function makeSummary(
  overrides: Partial<ReferralStatsSummary> = {}
): ReferralStatsSummary {
  return { ...EMPTY_REFERRAL_STATS_SUMMARY, ...overrides }
}

function mockAdminPage(
  items: ReferralInvitation[],
  total: number,
  summary: ReferralStatsSummary = EMPTY_REFERRAL_STATS_SUMMARY
) {
  return {
    data: {
      success: true,
      data: {
        items,
        total,
        window_months: 1,
        commission_enabled: true,
        summary,
      },
    },
  }
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <ReferralAdminDialog open onOpenChange={vi.fn()} />
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
        return 'blob:referral-invitations'
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

it('summarizes all seven commission states of the filtered list', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    mockAdminPage(
      [makeInvitation()],
      23,
      makeSummary({
        total_invitees: 23,
        invitees_with_commission: 9,
        total_paid_quota: 7_000_000,
        total_commission_quota: 4_900_000,
        pending_quota: 2_000_000,
        locked_quota: 1_000_000,
        settled_quota: 500_000,
        refunded_quota: 600_000,
        review_quota: 400_000,
        blocked_quota: 300_000,
        rejected_quota: 100_000,
      })
    )
  )
  renderDialog()
  await screen.findByText('invitee-7')

  expect(screen.getByText('23')).toBeVisible()
  expect(screen.getByText('9')).toBeVisible()
  const breakdown = [
    `${i18n.t('Pending')}: ${formatQuota(2_000_000)}`,
    `${i18n.t('Locked')}: ${formatQuota(1_000_000)}`,
    `${i18n.t('Settled')}: ${formatQuota(500_000)}`,
    `${i18n.t('Refunded')}: ${formatQuota(600_000)}`,
    `${i18n.t('In Review')}: ${formatQuota(400_000)}`,
    `${i18n.t('Blocked by risk control')}: ${formatQuota(300_000)}`,
    `${i18n.t('Rejected')}: ${formatQuota(100_000)}`,
  ].join(' · ')
  expect(document.body.textContent).toContain(breakdown)
})

it('names the anti-abuse commission states on an administrative row', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    mockAdminPage(
      [
        makeInvitation({
          pending_quota: 100_000,
          refunded_quota: 200_000,
          blocked_quota: 300_000,
          total_paid_quota: 500_000,
        }),
      ],
      1
    )
  )
  renderDialog()
  await screen.findByText('invitee-7')

  expect(
    screen.getByText(
      `${i18n.t('Pending')} · ${i18n.t('Refunded')} · ${i18n.t('Blocked by risk control')}`
    )
  ).toBeVisible()
  expect(screen.getByText(formatQuota(600_000))).toBeVisible()
})

it('sends the keyword filter to the administrative list endpoint', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(mockAdminPage([makeInvitation()], 1))
  renderDialog()
  await screen.findByText('invitee-7')

  fireEvent.change(screen.getByLabelText(i18n.t('Search invitees')), {
    target: { value: 'ali' },
  })
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/api/user/referrals?p=1&page_size=20&keyword=ali'
    )
  )
})

it('downloads the administrative list as CSV', async () => {
  const downloads = captureDownloads()
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(mockAdminPage([makeInvitation()], 1))
  renderDialog()
  await screen.findByText('invitee-7')

  get.mockResolvedValueOnce({
    data: new Blob(['invitee_id,identifier\n7,inv***\n'], { type: 'text/csv' }),
  })
  fireEvent.click(screen.getByRole('button', { name: i18n.t('Export CSV') }))
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith('/api/user/referrals/export', {
      responseType: 'blob',
    })
  )
  await waitFor(() => expect(downloads).toHaveLength(1))
  expect(downloads[0].filename).toBe('referral-invitations.csv')
  expect(downloads[0].blob.type).toBe('text/csv')
})

it('disables the export while there are no invitations', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(mockAdminPage([], 0))
  renderDialog()
  await screen.findByText(i18n.t('No invitees yet'))

  expect(
    screen.getByRole('button', { name: i18n.t('Export CSV') })
  ).toBeDisabled()
})
