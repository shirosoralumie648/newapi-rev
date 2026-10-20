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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { PlaygroundUsageAnalyticsPanel } from '../playground-usage-analytics'

const downloadCsv = vi.hoisted(() => vi.fn())
vi.mock('@/features/usage-logs/lib/export', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/usage-logs/lib/export')>()
  return { ...actual, downloadCsv }
})

const chart = vi.hoisted(() =>
  vi.fn(
    (_props: {
      spec: {
        data: {
          values: Array<{ origin: string; quota: number; usage: number }>
        }[]
      }
    }) => null
  )
)
vi.mock('@visactor/react-vchart', () => ({ VChart: chart }))
vi.mock('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: vi.fn() },
}))

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const windowStart = Date.UTC(2026, 9, 12) / 1000
const windowEnd = Date.UTC(2026, 9, 18, 12) / 1000

const analytics = {
  enabled: true,
  start_timestamp: windowStart,
  end_timestamp: windowEnd,
  buckets: [
    {
      day_start: windowStart,
      model_name: 'gpt-4o',
      origin: 'playground',
      quota: 300000,
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_tokens: 40,
      requests: 2,
      errors: 0,
      avg_time_seconds: 4,
      avg_first_token_ms: 300,
    },
    {
      day_start: windowStart,
      model_name: 'gpt-4o',
      origin: 'api',
      quota: 100000,
      prompt_tokens: 100,
      completion_tokens: 0,
      cache_tokens: 0,
      requests: 1,
      errors: 1,
      avg_time_seconds: 8,
      avg_first_token_ms: 700,
    },
  ],
}

let testI18n: i18n

function mockAnalytics(data: unknown = analytics) {
  return vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data },
  })
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <PlaygroundUsageAnalyticsPanel active userId={7} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

beforeEach(async () => {
  chart.mockClear()
  downloadCsv.mockClear()
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

test('renders the summary, the trend chart and the model table', async () => {
  mockAnalytics()
  renderPanel()

  expect(await screen.findByText('Total spend')).toBeVisible()
  expect(screen.getByText('gpt-4o')).toBeVisible()
  expect(screen.getAllByText('Average TTFT')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled()
  expect(api.get).toHaveBeenCalledWith(
    '/api/playground/usage/analytics',
    expect.objectContaining({ params: { days: 7 } })
  )

  await waitFor(() => expect(chart).toHaveBeenCalled())
  const values = chart.mock.calls[0][0].spec.data[0].values
  expect(values).toHaveLength(14)
  const playground = values.filter((value) => value.origin === 'Playground')
  expect(playground).toHaveLength(7)
  expect(playground.reduce((sum, value) => sum + value.quota, 0)).toBe(300000)
  const direct = values.filter((value) => value.origin === 'API')
  expect(direct.reduce((sum, value) => sum + value.quota, 0)).toBe(100000)
})

test('an empty range explains itself instead of rendering empty charts', async () => {
  mockAnalytics({ ...analytics, buckets: [] })
  renderPanel()

  expect(await screen.findByText('No usage in this range yet')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
  expect(chart).not.toHaveBeenCalled()
})

test('switching the range requests the newly selected window', async () => {
  mockAnalytics()
  const user = userEvent.setup()
  renderPanel()

  expect(
    await screen.findByRole('button', { name: 'Last 7 days' })
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Last 30 days' }))

  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      '/api/playground/usage/analytics',
      expect.objectContaining({ params: { days: 30 } })
    )
  )
})

test('a deployment with usage logging off says so while showing stored rows', async () => {
  mockAnalytics({ ...analytics, enabled: false })
  renderPanel()

  expect(
    await screen.findByText(
      'Usage logging is disabled on this deployment, so new requests are not recorded.'
    )
  ).toBeVisible()
  expect(screen.getByText('gpt-4o')).toBeVisible()
})

test('a capped answer says that only the newest groups are shown', async () => {
  mockAnalytics({ ...analytics, truncated: true })
  renderPanel()

  expect(
    await screen.findByText(
      'Only the most recent usage is shown because this range is too large to display in full.'
    )
  ).toBeVisible()
})

test('a failed request shows the error state', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('analytics unavailable'))
  renderPanel()

  expect(
    await screen.findByText('Failed to load usage analytics')
  ).toBeVisible()
})

test('exporting writes the displayed rows as a CSV file', async () => {
  mockAnalytics({
    ...analytics,
    buckets: [
      ...analytics.buckets,
      {
        day_start: windowStart,
        model_name: '=SUM(A1)',
        origin: 'api',
        quota: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_tokens: 0,
        requests: 0,
        errors: 0,
        avg_time_seconds: 0,
        avg_first_token_ms: 0,
      },
    ],
  })
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: 'Export CSV' }))

  expect(downloadCsv).toHaveBeenCalledTimes(1)
  const [filename, lines] = downloadCsv.mock.calls[0] as [string, string[]]
  expect(filename).toBe('playground-usage-7d.csv')
  expect(lines).toHaveLength(4)
  expect(lines[0]).toContain('"Date","Model","Origin"')
  const modelLine = lines.find((line) => line.includes('"gpt-4o"'))
  expect(modelLine).toBeDefined()
  expect(modelLine).toContain('"2026-10-12"')
  expect(lines.some((line) => line.includes(`"'=SUM(A1)"`))).toBe(true)
})
