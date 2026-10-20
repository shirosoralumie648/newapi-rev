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
import { describe, expect, it } from 'vitest'

import {
  buildPlaygroundUsageCsvRows,
  buildPlaygroundUsageTrendSeries,
  groupPlaygroundUsageByModel,
  summarizePlaygroundUsage,
  type PlaygroundUsageAnalyticsBucket,
} from '../playground-usage-analytics'

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

function bucket(
  overrides: Partial<PlaygroundUsageAnalyticsBucket> = {}
): PlaygroundUsageAnalyticsBucket {
  return {
    dayStart: day('2026-10-13'),
    modelName: 'gpt-4o',
    origin: 'playground',
    quota: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheTokens: 0,
    requests: 0,
    errors: 0,
    avgTimeSeconds: 0,
    avgFirstTokenMs: 0,
    timedRequests: 0,
    firstTokenSamples: 0,
    ...overrides,
  }
}

describe('summarizePlaygroundUsage', () => {
  it('sums quota, tokens and requests and splits them by origin', () => {
    const totals = summarizePlaygroundUsage([
      bucket({
        quota: 300,
        promptTokens: 100,
        completionTokens: 50,
        cacheTokens: 40,
        requests: 2,
      }),
      bucket({
        origin: 'api',
        quota: 100,
        promptTokens: 100,
        requests: 1,
      }),
    ])

    expect(totals.quota).toBe(400)
    expect(totals.playgroundQuota).toBe(300)
    expect(totals.apiQuota).toBe(100)
    expect(totals.requests).toBe(3)
    expect(totals.playgroundRequests).toBe(2)
    expect(totals.apiRequests).toBe(1)
    expect(totals.promptTokens).toBe(200)
    expect(totals.completionTokens).toBe(50)
    expect(totals.cacheTokens).toBe(40)
    expect(totals.cacheHitRate).toBe(20)
  })

  it('weights the averages by the measured request count, not every request', () => {
    const totals = summarizePlaygroundUsage([
      bucket({
        requests: 5,
        timedRequests: 1,
        avgTimeSeconds: 10,
        firstTokenSamples: 1,
        avgFirstTokenMs: 100,
      }),
      bucket({
        origin: 'api',
        requests: 1,
        timedRequests: 1,
        avgTimeSeconds: 2,
        firstTokenSamples: 1,
        avgFirstTokenMs: 200,
      }),
    ])

    expect(totals.avgTimeSeconds).toBe(6)
    expect(totals.avgFirstTokenMs).toBe(150)
  })

  it('computes the error rate over every recorded row', () => {
    const totals = summarizePlaygroundUsage([
      bucket({ requests: 3, errors: 1 }),
    ])

    expect(totals.errorRate).toBe(25)
  })

  it('summarizes an empty range as zeros', () => {
    expect(summarizePlaygroundUsage([])).toEqual({
      quota: 0,
      playgroundQuota: 0,
      apiQuota: 0,
      requests: 0,
      playgroundRequests: 0,
      apiRequests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheTokens: 0,
      cacheHitRate: 0,
      errorRate: 0,
      avgTimeSeconds: 0,
      avgFirstTokenMs: 0,
    })
  })
})

describe('groupPlaygroundUsageByModel', () => {
  const modelBuckets = [
    bucket({ modelName: 'alpha', quota: 100, requests: 10, promptTokens: 10 }),
    bucket({ modelName: 'beta', quota: 500, requests: 1, promptTokens: 10 }),
    bucket({
      modelName: 'gamma',
      quota: 10,
      requests: 5,
      promptTokens: 1000,
      completionTokens: 1000,
    }),
  ]

  it('groups the origins of one model into a single row', () => {
    const rows = groupPlaygroundUsageByModel([
      bucket({ modelName: 'alpha', quota: 300, requests: 2 }),
      bucket({ modelName: 'alpha', origin: 'api', quota: 100, requests: 1 }),
      bucket({ modelName: 'beta', quota: 50 }),
    ])

    const alpha = rows.find((row) => row.modelName === 'alpha')
    expect(alpha?.quota).toBe(400)
    expect(alpha?.playgroundQuota).toBe(300)
    expect(alpha?.apiQuota).toBe(100)
    expect(alpha?.requests).toBe(3)
    expect(rows.map((row) => row.modelName)).toEqual(['alpha', 'beta'])
  })

  it('orders the models by the selected metric', () => {
    expect(groupPlaygroundUsageByModel(modelBuckets)[0].modelName).toBe('beta')
    expect(
      groupPlaygroundUsageByModel(modelBuckets, 'requests')[0].modelName
    ).toBe('alpha')
    expect(
      groupPlaygroundUsageByModel(modelBuckets, 'tokens')[0].modelName
    ).toBe('gamma')
  })

  it('breaks ties on equal values by the model name', () => {
    const rows = groupPlaygroundUsageByModel([
      bucket({ modelName: 'zulu', quota: 100 }),
      bucket({ modelName: 'alpha', quota: 100 }),
    ])

    expect(rows.map((row) => row.modelName)).toEqual(['alpha', 'zulu'])
  })
})

describe('buildPlaygroundUsageTrendSeries', () => {
  it('fills days without usage so the axis stays continuous', () => {
    const points = buildPlaygroundUsageTrendSeries(
      [
        bucket({ dayStart: day('2026-10-14'), quota: 100 }),
        bucket({ dayStart: day('2026-10-15'), origin: 'api', quota: 50 }),
      ],
      3,
      day('2026-10-15') + 12 * 3_600_000
    )

    expect(points.map((point) => point.label)).toEqual([
      '10-13',
      '10-14',
      '10-15',
    ])
    expect(points[0].quota).toBe(0)
    expect(points[1].playgroundQuota).toBe(100)
    expect(points[2].apiQuota).toBe(50)
  })

  it('ignores buckets outside the requested range', () => {
    const points = buildPlaygroundUsageTrendSeries(
      [bucket({ dayStart: day('2026-10-20'), quota: 999 })],
      3,
      day('2026-10-15') + 3_600_000
    )

    expect(points).toHaveLength(3)
    expect(points.every((point) => point.quota === 0)).toBe(true)
  })

  it('folds a range longer than 31 days into seven-day windows', () => {
    const points = buildPlaygroundUsageTrendSeries(
      [
        bucket({ dayStart: day('2026-07-18'), quota: 10 }),
        bucket({ dayStart: day('2026-10-15'), origin: 'api', quota: 20 }),
      ],
      90,
      day('2026-10-15') + 3_600_000
    )

    expect(points).toHaveLength(13)
    expect(points[0].days).toBe(7)
    expect(points[0].quota).toBe(10)
    expect(points[points.length - 1].days).toBe(6)
    expect(points[points.length - 1].apiQuota).toBe(20)
  })
})

describe('buildPlaygroundUsageCsvRows', () => {
  it('orders the rows by day, model and origin', () => {
    const rows = buildPlaygroundUsageCsvRows([
      bucket({ dayStart: day('2026-10-14'), modelName: 'beta' }),
      bucket({ dayStart: day('2026-10-13'), modelName: 'beta' }),
      bucket({ dayStart: day('2026-10-13'), modelName: 'alpha' }),
      bucket({
        dayStart: day('2026-10-13'),
        modelName: 'alpha',
        origin: 'api',
      }),
    ])

    expect(
      rows.map((row) => `${row.date} ${row.modelName} ${row.origin}`)
    ).toEqual([
      '2026-10-13 alpha api',
      '2026-10-13 alpha playground',
      '2026-10-13 beta playground',
      '2026-10-14 beta playground',
    ])
  })

  it('renders the UTC calendar date of each bucket', () => {
    const rows = buildPlaygroundUsageCsvRows([
      bucket({ dayStart: day('2026-01-02') }),
    ])

    expect(rows[0].date).toBe('2026-01-02')
  })
})
