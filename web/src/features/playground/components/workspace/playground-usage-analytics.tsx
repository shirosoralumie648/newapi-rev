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
import { VChart } from '@visactor/react-vchart'
import { ChartColumn, Download } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import type { StaticDataTableColumn } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatLatency } from '@/features/performance-metrics/lib/format'
import { downloadCsv, toCsvLine } from '@/features/usage-logs/lib/export'
import { toIntlLocale } from '@/i18n/languages'
import {
  formatLogQuota,
  formatNumber,
  formatPercent,
  formatUseTime,
  quotaUnitsToDollars,
} from '@/lib/format'
import { getServerMessage } from '@/lib/server-error-message'
import { useChartTheme } from '@/lib/use-chart-theme'
import { VCHART_OPTION } from '@/lib/vchart'

import {
  PLAYGROUND_USAGE_DEFAULT_RANGE_DAYS,
  PLAYGROUND_USAGE_RANGE_DAYS,
  PLAYGROUND_USAGE_SORT_OPTIONS,
} from '../../constants'
import { usePlaygroundUsageAnalytics } from '../../hooks'
import {
  buildPlaygroundUsageCsvRows,
  buildPlaygroundUsageTrendSeries,
  groupPlaygroundUsageByModel,
  summarizePlaygroundUsage,
  type PlaygroundUsageModelSummary,
  type PlaygroundUsageSortKey,
} from '../../lib'

interface PlaygroundUsageAnalyticsProps {
  /** Loads the analytics only while the Inspector shows this panel. */
  active: boolean
  userId: number | null
}

/**
 * The Playground usage and performance view of the Inspector. It presents the
 * settled usage of the caller's own requests by model and by day, keeping the
 * Playground workspace and the direct API origins apart, and exports exactly
 * the figures it displays. Every figure is read-only: nothing here reserves,
 * settles or recalculates quota.
 */
export function PlaygroundUsageAnalyticsPanel(
  props: PlaygroundUsageAnalyticsProps
) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const { themeReady, resolvedTheme } = useChartTheme()
  const [days, setDays] = useState<number>(PLAYGROUND_USAGE_DEFAULT_RANGE_DAYS)
  const [sort, setSort] = useState<PlaygroundUsageSortKey>('quota')
  const analyticsQuery = usePlaygroundUsageAnalytics(
    props.userId,
    days,
    props.active
  )

  const buckets = analyticsQuery.data?.buckets ?? []
  const totals = useMemo(() => summarizePlaygroundUsage(buckets), [buckets])
  const modelRows = useMemo(
    () => groupPlaygroundUsageByModel(buckets, sort),
    [buckets, sort]
  )
  const trendPoints = useMemo(
    () =>
      buildPlaygroundUsageTrendSeries(
        buckets,
        days,
        analyticsQuery.data?.endTimestamp ?? 0
      ),
    [analyticsQuery.data?.endTimestamp, buckets, days]
  )

  const chartValues = useMemo(() => {
    const values: Array<{
      day: string
      origin: string
      usage: number
      quota: number
    }> = []
    for (const point of trendPoints) {
      values.push({
        day: point.label,
        origin: t('Playground'),
        usage: quotaUnitsToDollars(point.playgroundQuota),
        quota: point.playgroundQuota,
      })
      values.push({
        day: point.label,
        origin: t('API'),
        usage: quotaUnitsToDollars(point.apiQuota),
        quota: point.apiQuota,
      })
    }
    return values
  }, [t, trendPoints])

  const chartSpec = useMemo(
    () => ({
      type: 'bar',
      data: [{ id: 'playground-usage-trend', values: chartValues }],
      xField: 'day',
      yField: 'usage',
      seriesField: 'origin',
      stack: true,
      theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      legends: { visible: true, selectMode: 'single' },
      bar: { state: { hover: { stroke: '#000', lineWidth: 1 } } },
      tooltip: {
        mark: {
          content: [
            {
              key: (datum: Record<string, unknown>) => datum?.origin,
              value: (datum: Record<string, unknown>) =>
                formatLogQuota(Number(datum?.quota) || 0),
            },
          ],
        },
      },
      background: 'transparent',
    }),
    [chartValues, resolvedTheme]
  )

  const sortItems = useMemo<Array<{ value: string; label: string }>>(
    () =>
      PLAYGROUND_USAGE_SORT_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t]
  )

  const columns = useMemo<StaticDataTableColumn<PlaygroundUsageModelSummary>[]>(
    () => [
      {
        id: 'model',
        header: t('Model'),
        cell: (row) => row.modelName || '-',
      },
      {
        id: 'quota',
        header: t('Cost'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatLogQuota(row.quota),
      },
      {
        id: 'requests',
        header: t('Requests'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatNumber(row.requests, locale),
      },
      {
        id: 'errors',
        header: t('Errors'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatNumber(row.errors, locale),
      },
      {
        id: 'input-tokens',
        header: t('Input Tokens'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatNumber(row.promptTokens, locale),
      },
      {
        id: 'output-tokens',
        header: t('Output Tokens'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatNumber(row.completionTokens, locale),
      },
      {
        id: 'cache-read',
        header: t('Cache Read'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatNumber(row.cacheTokens, locale),
      },
      {
        id: 'cache-hit-rate',
        header: t('Cache hit rate'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatPercent(row.cacheHitRate),
      },
      {
        id: 'avg-ttft',
        header: t('Average TTFT'),
        className: 'text-right',
        cellClassName: 'text-right tabular-nums',
        cell: (row) => formatLatency(row.avgFirstTokenMs),
      },
    ],
    [locale, t]
  )

  const handleExportCsv = useCallback(() => {
    const rows = buildPlaygroundUsageCsvRows(buckets)
    const lines = [
      toCsvLine([
        t('Date'),
        t('Model'),
        t('Origin'),
        t('Requests'),
        t('Errors'),
        t('Input Tokens'),
        t('Output Tokens'),
        t('Cache Read'),
        t('Cost'),
      ]),
      ...rows.map((row) =>
        toCsvLine([
          row.date,
          row.modelName,
          row.origin === 'playground' ? t('Playground') : t('API'),
          String(row.requests),
          String(row.errors),
          String(row.promptTokens),
          String(row.completionTokens),
          String(row.cacheTokens),
          formatLogQuota(row.quota),
        ])
      ),
    ]
    downloadCsv(`playground-usage-${days}d.csv`, lines)
  }, [buckets, days, t])

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2'>
        <ToggleGroup
          aria-label={t('Time range')}
          onValueChange={(values) => {
            const next = Number(values[0])
            if (PLAYGROUND_USAGE_RANGE_DAYS.some((range) => range === next)) {
              setDays(next)
            }
          }}
          size='sm'
          value={[String(days)]}
          variant='outline'
        >
          {PLAYGROUND_USAGE_RANGE_DAYS.map((range) => (
            <ToggleGroupItem key={range} value={String(range)}>
              {t('Last {{days}} days', { days: range })}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button
          disabled={buckets.length === 0}
          onClick={handleExportCsv}
          size='sm'
          type='button'
          variant='outline'
        >
          <Download aria-hidden='true' />
          {t('Export CSV')}
        </Button>
      </div>

      {analyticsQuery.data && !analyticsQuery.data.enabled && (
        <p className='text-muted-foreground border-b px-3 py-2 text-xs'>
          {t(
            'Usage logging is disabled on this deployment, so new requests are not recorded.'
          )}
        </p>
      )}

      {analyticsQuery.data?.truncated && (
        <p className='text-muted-foreground border-b px-3 py-2 text-xs'>
          {t(
            'Only the most recent usage is shown because this range is too large to display in full.'
          )}
        </p>
      )}

      {analyticsQuery.isError && (
        <div className='shrink-0 p-2'>
          <ErrorState
            className='min-h-0 p-2'
            description={getServerMessage(analyticsQuery.error)}
            onRetry={() => void analyticsQuery.refetch()}
            title={t('Failed to load usage analytics')}
          />
        </div>
      )}

      {analyticsQuery.isPending && (
        <div className='flex min-h-0 flex-1 items-center justify-center p-4'>
          <LoadingState className='min-h-24' />
        </div>
      )}

      {analyticsQuery.isSuccess && buckets.length === 0 && (
        <div className='flex min-h-0 flex-1 items-center justify-center p-4'>
          <EmptyState
            description={t(
              'Spend, tokens and latency appear here after your first request.'
            )}
            icon={ChartColumn}
            title={t('No usage in this range yet')}
          />
        </div>
      )}

      {analyticsQuery.isSuccess && buckets.length > 0 && (
        <ScrollArea className='min-h-0 flex-1'>
          <div className='flex flex-col gap-3 p-3'>
            <div className='grid grid-cols-2 gap-3 rounded-lg border px-3 py-3'>
              <UsageMetric
                label={t('Total spend')}
                value={formatLogQuota(totals.quota)}
              />
              <UsageMetric
                label={t('Playground')}
                value={formatLogQuota(totals.playgroundQuota)}
              />
              <UsageMetric
                label={t('API')}
                value={formatLogQuota(totals.apiQuota)}
              />
              <UsageMetric
                label={t('Cache hit rate')}
                value={formatPercent(totals.cacheHitRate)}
              />
              <UsageMetric
                label={t('Error rate')}
                value={formatPercent(totals.errorRate)}
              />
              <UsageMetric
                label={t('Average TTFT')}
                value={formatLatency(totals.avgFirstTokenMs)}
              />
              <UsageMetric
                label={t('Average time')}
                value={formatUseTime(totals.avgTimeSeconds)}
              />
              <UsageMetric
                label={t('Requests')}
                value={formatNumber(totals.requests, locale)}
              />
            </div>

            <div className='overflow-hidden rounded-lg border'>
              <div className='border-b px-3 py-2 text-xs font-medium'>
                {t('Daily spend')}
              </div>
              <div className='h-56 p-1.5'>
                {themeReady && (
                  <VChart option={VCHART_OPTION} spec={chartSpec} />
                )}
              </div>
            </div>

            <div className='overflow-hidden rounded-lg border'>
              <div className='flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2'>
                <span className='text-xs font-medium'>
                  {t('Spend by model')}
                </span>
                <Select
                  items={sortItems}
                  onValueChange={(value) => {
                    if (
                      typeof value === 'string' &&
                      PLAYGROUND_USAGE_SORT_OPTIONS.some(
                        (option) => option.value === value
                      )
                    ) {
                      setSort(value as PlaygroundUsageSortKey)
                    }
                  }}
                  value={sort}
                >
                  <SelectTrigger aria-label={t('Sort by')} size='sm'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {sortItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <StaticDataTable
                columns={columns}
                data={modelRows}
                emptyContent={t('No usage in this range yet')}
                getRowKey={(row) => row.modelName}
                tableClassName='min-w-[560px]'
              />
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

function UsageMetric(props: { label: string; value: string }) {
  return (
    <div className='flex min-w-0 flex-col gap-0.5'>
      <span className='text-muted-foreground truncate text-xs'>
        {props.label}
      </span>
      <span className='truncate font-mono text-sm font-semibold tabular-nums'>
        {props.value}
      </span>
    </div>
  )
}
