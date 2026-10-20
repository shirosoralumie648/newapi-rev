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
// Read-only shapes and pure folds of the Playground usage analytics. The
// server aggregates the settled log rows by day, model and origin; everything
// here only reshapes those sums for the Inspector and never touches billing.

/** Where one settled usage row came from: the Playground or the direct API. */
export type PlaygroundUsageOrigin = 'playground' | 'api'

/**
 * One day x model x origin group of the caller's settled usage rows.
 * `dayStart` is the UTC midnight the rows fall in, in milliseconds; the server
 * buckets by whole UTC days, so every timestamp here is timezone-stable.
 */
export interface PlaygroundUsageAnalyticsBucket {
  dayStart: number
  modelName: string
  origin: PlaygroundUsageOrigin
  quota: number
  promptTokens: number
  completionTokens: number
  cacheTokens: number
  requests: number
  errors: number
  avgTimeSeconds: number
  avgFirstTokenMs: number
}

/**
 * The caller's read-only usage/performance answer over the requested day
 * range. `enabled` mirrors the runtime consume-log setting, so the view can
 * explain an empty range instead of waiting for rows the gateway never writes.
 */
export interface PlaygroundUsageAnalytics {
  enabled: boolean
  startTimestamp: number
  endTimestamp: number
  buckets: PlaygroundUsageAnalyticsBucket[]
}

const DAY_MS = 86_400_000
// Above this many days the trend chart switches from one bar per day to
// seven-day windows, so a 90-day range stays readable.
const TREND_MAX_DAILY_DAYS = 31
const TREND_WINDOW_DAYS = 7

/** Request-weighted sums over a set of analytics buckets. */
export interface PlaygroundUsageTotals {
  quota: number
  playgroundQuota: number
  apiQuota: number
  requests: number
  playgroundRequests: number
  apiRequests: number
  errors: number
  promptTokens: number
  completionTokens: number
  cacheTokens: number
  /** Cached prompt tokens as a share of all prompt tokens, in percent. */
  cacheHitRate: number
  /** Error rows as a share of all recorded rows, in percent. */
  errorRate: number
  /** Request-weighted average wall time, in seconds. */
  avgTimeSeconds: number
  /** Request-weighted average first-token wait, in milliseconds. */
  avgFirstTokenMs: number
}

/**
 * Folds the day x model x origin buckets into one summary. Every figure is a
 * sum of the stored rows; the two rates and the two averages are derived from
 * the same sums with zero-safe guards, so an empty range summarizes to zeros.
 */
export function summarizePlaygroundUsage(
  buckets: PlaygroundUsageAnalyticsBucket[]
): PlaygroundUsageTotals {
  const totals: PlaygroundUsageTotals = {
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
  }
  let timeTotal = 0
  let timeWeight = 0
  let firstTokenTotal = 0
  let firstTokenWeight = 0
  for (const bucket of buckets) {
    totals.quota += bucket.quota
    totals.requests += bucket.requests
    totals.errors += bucket.errors
    totals.promptTokens += bucket.promptTokens
    totals.completionTokens += bucket.completionTokens
    totals.cacheTokens += bucket.cacheTokens
    if (bucket.origin === 'playground') {
      totals.playgroundQuota += bucket.quota
      totals.playgroundRequests += bucket.requests
    } else {
      totals.apiQuota += bucket.quota
      totals.apiRequests += bucket.requests
    }
    if (bucket.avgTimeSeconds > 0 && bucket.requests > 0) {
      timeTotal += bucket.avgTimeSeconds * bucket.requests
      timeWeight += bucket.requests
    }
    if (bucket.avgFirstTokenMs > 0 && bucket.requests > 0) {
      firstTokenTotal += bucket.avgFirstTokenMs * bucket.requests
      firstTokenWeight += bucket.requests
    }
  }
  if (totals.promptTokens > 0) {
    totals.cacheHitRate = (totals.cacheTokens / totals.promptTokens) * 100
  }
  const recordedRows = totals.requests + totals.errors
  if (recordedRows > 0) {
    totals.errorRate = (totals.errors / recordedRows) * 100
  }
  if (timeWeight > 0) {
    totals.avgTimeSeconds = Math.round(timeTotal / timeWeight)
  }
  if (firstTokenWeight > 0) {
    totals.avgFirstTokenMs = Math.round(firstTokenTotal / firstTokenWeight)
  }
  return totals
}

/** The model table orderings the Inspector offers. */
export type PlaygroundUsageSortKey = 'quota' | 'requests' | 'tokens'

/** One model's totals across every day and origin in the range. */
export interface PlaygroundUsageModelSummary extends PlaygroundUsageTotals {
  modelName: string
  totalTokens: number
}

/**
 * Groups the buckets by model, then orders the rows by the selected key with
 * the largest value first and the model name as the stable tiebreaker.
 */
export function groupPlaygroundUsageByModel(
  buckets: PlaygroundUsageAnalyticsBucket[],
  sort: PlaygroundUsageSortKey = 'quota'
): PlaygroundUsageModelSummary[] {
  const grouped = new Map<string, PlaygroundUsageAnalyticsBucket[]>()
  for (const bucket of buckets) {
    const group = grouped.get(bucket.modelName)
    if (group) {
      group.push(bucket)
    } else {
      grouped.set(bucket.modelName, [bucket])
    }
  }
  const rows: PlaygroundUsageModelSummary[] = []
  for (const [modelName, group] of grouped) {
    const totals = summarizePlaygroundUsage(group)
    rows.push({
      ...totals,
      modelName,
      totalTokens: totals.promptTokens + totals.completionTokens,
    })
  }
  rows.sort((a, b) => {
    let difference = b.quota - a.quota
    if (sort === 'requests') difference = b.requests - a.requests
    else if (sort === 'tokens') difference = b.totalTokens - a.totalTokens
    return difference !== 0
      ? difference
      : a.modelName.localeCompare(b.modelName)
  })
  return rows
}

/** One bar of the spend/volume trend. */
export interface PlaygroundUsageTrendPoint {
  /** First UTC day of the point, in milliseconds. */
  dayStart: number
  /** UTC days the point covers: 1, or the window length above 31 days. */
  days: number
  /** UTC month-day of the first covered day, e.g. "10-19". */
  label: string
  requests: number
  quota: number
  playgroundQuota: number
  apiQuota: number
}

/**
 * Builds the spend/volume trend over the requested range and fills days
 * without any usage, so the chart keeps a continuous time axis. A range longer
 * than 31 days folds into seven-day windows; every bucket is aligned to UTC
 * days, matching the server aggregation.
 */
export function buildPlaygroundUsageTrendSeries(
  buckets: PlaygroundUsageAnalyticsBucket[],
  days: number,
  endTimestamp: number
): PlaygroundUsageTrendPoint[] {
  if (days < 1 || !Number.isFinite(endTimestamp) || endTimestamp <= 0) return []
  const endDayStart = Math.floor(endTimestamp / DAY_MS) * DAY_MS
  const startDayStart = endDayStart - (days - 1) * DAY_MS
  const daily = new Map<number, PlaygroundUsageTrendPoint>()
  for (let offset = 0; offset < days; offset += 1) {
    const dayStart = startDayStart + offset * DAY_MS
    daily.set(dayStart, {
      dayStart,
      days: 1,
      label: utcDayLabel(dayStart),
      requests: 0,
      quota: 0,
      playgroundQuota: 0,
      apiQuota: 0,
    })
  }
  for (const bucket of buckets) {
    const dayStart = Math.floor(bucket.dayStart / DAY_MS) * DAY_MS
    const point = daily.get(dayStart)
    if (!point) continue
    point.requests += bucket.requests
    point.quota += bucket.quota
    if (bucket.origin === 'playground') {
      point.playgroundQuota += bucket.quota
    } else {
      point.apiQuota += bucket.quota
    }
  }
  const points = [...daily.values()]
  if (days <= TREND_MAX_DAILY_DAYS) return points
  const windows: PlaygroundUsageTrendPoint[] = []
  for (let index = 0; index < points.length; index += TREND_WINDOW_DAYS) {
    const chunk = points.slice(index, index + TREND_WINDOW_DAYS)
    const first = chunk[0]
    const window: PlaygroundUsageTrendPoint = {
      dayStart: first.dayStart,
      days: chunk.length,
      label: first.label,
      requests: 0,
      quota: 0,
      playgroundQuota: 0,
      apiQuota: 0,
    }
    for (const point of chunk) {
      window.requests += point.requests
      window.quota += point.quota
      window.playgroundQuota += point.playgroundQuota
      window.apiQuota += point.apiQuota
    }
    windows.push(window)
  }
  return windows
}

/** One day x model x origin line of the exported usage CSV file. */
export interface PlaygroundUsageCsvRow {
  /** First UTC day of the row, in milliseconds. */
  dayStart: number
  /** UTC calendar date of that day, as `YYYY-MM-DD`. */
  date: string
  modelName: string
  origin: PlaygroundUsageOrigin
  requests: number
  errors: number
  promptTokens: number
  completionTokens: number
  cacheTokens: number
  quota: number
}

/**
 * One CSV row per day x model x origin group, ordered the same way the server
 * returns them: by day, then model, then origin.
 */
export function buildPlaygroundUsageCsvRows(
  buckets: PlaygroundUsageAnalyticsBucket[]
): PlaygroundUsageCsvRow[] {
  return buckets
    .map((bucket) => {
      const dayStart = Math.floor(bucket.dayStart / DAY_MS) * DAY_MS
      return {
        dayStart,
        date: utcDayDate(dayStart),
        modelName: bucket.modelName,
        origin: bucket.origin,
        requests: bucket.requests,
        errors: bucket.errors,
        promptTokens: bucket.promptTokens,
        completionTokens: bucket.completionTokens,
        cacheTokens: bucket.cacheTokens,
        quota: bucket.quota,
      }
    })
    .sort((a, b) => {
      if (a.dayStart !== b.dayStart) return a.dayStart - b.dayStart
      if (a.modelName !== b.modelName) {
        return a.modelName.localeCompare(b.modelName)
      }
      return a.origin.localeCompare(b.origin)
    })
}

/** UTC month-day label of a millisecond timestamp, e.g. "10-19". */
function utcDayLabel(dayStart: number): string {
  const date = new Date(dayStart)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${month}-${day}`
}

/** UTC calendar date of a millisecond timestamp, as `YYYY-MM-DD`. */
function utcDayDate(dayStart: number): string {
  const date = new Date(dayStart)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}
