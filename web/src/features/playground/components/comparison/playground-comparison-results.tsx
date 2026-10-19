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
import { Download, Star } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  StaticDataTable,
  type StaticDataTableColumn,
} from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { formatLogQuota } from '@/lib/format'
import { cn } from '@/lib/utils'

import {
  comparisonCellKey,
  comparisonCostSummary,
  comparisonDifferenceQuota,
  comparisonExportContent,
  comparisonExportFileName,
  comparisonExportRows,
  comparisonRunCell,
  type PlaygroundComparisonExportFormat,
  type PlaygroundComparisonExportRow,
} from '../../lib'
import type {
  PlaygroundComparisonCell,
  PlaygroundComparisonCellStatus,
  PlaygroundComparisonRun,
  PlaygroundMessageCost,
} from '../../types'
import {
  COMPARISON_RUN_STATUS_LABELS,
  COMPARISON_RUN_STATUS_VARIANTS,
} from './comparison-status'

const CELL_STATUS_LABELS: Record<PlaygroundComparisonCellStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}

const CELL_STATUS_VARIANTS: Record<
  PlaygroundComparisonCellStatus,
  StatusVariant
> = {
  pending: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'warning',
}

interface PlaygroundComparisonResultsProps {
  costs: Map<string, PlaygroundMessageCost>
  onRetry: (cell: PlaygroundComparisonCell) => Promise<void>
  onSetBaseline: (model: string) => Promise<void>
  onStartNew: () => void
  onStop: () => void
  retryingKey: string | null
  run: PlaygroundComparisonRun | null
  running: boolean
}

/**
 * Result matrix of one compare run. Rows are model x prompt cells; the cost and
 * timing columns are read from the settled consume rows returned by the relay,
 * so an unfinished cell shows a dash instead of an invented price. Export keeps
 * the same normalized rows as the table.
 */
export function PlaygroundComparisonResults(
  props: PlaygroundComparisonResultsProps
) {
  const { t } = useTranslation()
  const rows = useMemo(
    () => (props.run ? comparisonExportRows(props.run, props.costs) : []),
    [props.run, props.costs]
  )
  const summary = useMemo(
    () =>
      props.run
        ? comparisonCostSummary(props.run, props.costs)
        : {
            actualQuota: 0,
            settledCells: 0,
            expectedCells: 0,
            hasAllCosts: false,
          },
    [props.run, props.costs]
  )

  if (!props.run) {
    return (
      <EmptyState
        action={
          <Button onClick={props.onStartNew} size='sm' type='button'>
            {t('Start a run')}
          </Button>
        }
        className='min-h-40'
        description={t('Start a compare run to fill this table.')}
        title={t('No comparison results yet')}
      />
    )
  }

  const run = props.run
  const difference = comparisonDifferenceQuota(run, summary)
  const busy = props.running || props.retryingKey !== null

  const handleExport = (format: PlaygroundComparisonExportFormat) => {
    const content = comparisonExportContent(format, run, props.costs)
    const types: Record<PlaygroundComparisonExportFormat, string> = {
      csv: 'text/csv;charset=utf-8',
      json: 'application/json;charset=utf-8',
      markdown: 'text/markdown;charset=utf-8',
    }
    const url = URL.createObjectURL(
      new Blob([content], { type: types[format] })
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = comparisonExportFileName(run, format)
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success(t('Comparison run exported'))
  }

  const columns: StaticDataTableColumn<PlaygroundComparisonExportRow>[] = [
    {
      id: 'prompt',
      header: t('Prompt'),
      className: 'w-[18%]',
      cell: (row) => `#${row.promptIndex + 1} ${row.prompt}`,
    },
    {
      id: 'model',
      header: t('Model'),
      className: 'w-[16%]',
      cell: (row) => {
        const baseline = run.baselineModel === row.model
        return (
          <div className='flex min-w-0 items-center gap-1'>
            <Button
              aria-label={
                baseline ? t('Clear baseline') : t('Mark as baseline')
              }
              aria-pressed={baseline}
              className={cn(
                'shrink-0',
                baseline && 'text-amber-500 hover:text-amber-500'
              )}
              disabled={busy}
              onClick={() => void props.onSetBaseline(row.model)}
              size='icon-xs'
              type='button'
              variant='ghost'
            >
              <Star
                aria-hidden='true'
                className={cn(baseline && 'fill-current')}
              />
            </Button>
            <span className={cn('truncate', baseline && 'font-medium')}>
              {row.model}
            </span>
          </div>
        )
      },
    },
    {
      id: 'status',
      header: t('Status'),
      cell: (row) => (
        <StatusBadge
          copyable={false}
          label={t(
            CELL_STATUS_LABELS[row.status as PlaygroundComparisonCellStatus]
          )}
          pulse={row.status === 'running'}
          variant={
            CELL_STATUS_VARIANTS[row.status as PlaygroundComparisonCellStatus]
          }
        />
      ),
    },
    {
      id: 'output',
      header: t('Output'),
      className: 'w-[24%]',
      cell: (row) => {
        if (row.status === 'failed') {
          return (
            <span className='text-destructive block max-w-56 truncate'>
              {row.error || t('Failed')}
              {row.errorCode ? ` · ${row.errorCode}` : ''}
            </span>
          )
        }
        return row.output ? (
          <span className='block max-w-56 truncate'>{row.output}</span>
        ) : (
          <span className='text-muted-foreground'>-</span>
        )
      },
    },
    {
      id: 'tokens',
      header: t('Tokens'),
      className: 'text-right',
      cell: (row) =>
        row.totalTokens > 0
          ? `${row.promptTokens} / ${row.completionTokens}`
          : '',
    },
    {
      id: 'cost',
      header: t('Cost'),
      className: 'text-right',
      cell: (row) =>
        row.quota !== undefined ? formatLogQuota(row.quota) : '-',
    },
    {
      id: 'ttft',
      header: t('TTFT'),
      className: 'text-right',
      cell: (row) => (row.ttftMs !== undefined ? `${row.ttftMs} ms` : '-'),
    },
    {
      id: 'total',
      header: t('Total time'),
      className: 'text-right',
      cell: (row) => {
        if (row.totalMs !== undefined) return `${row.totalMs} ms`
        return row.latencyMs > 0 ? `${row.latencyMs} ms` : '-'
      },
    },
    {
      id: 'actions',
      header: '',
      className: 'w-px text-right',
      cell: (row) => {
        const cell = comparisonRunCell(run, row.promptIndex, row.modelIndex)
        if (!cell || cell.status === 'succeeded') return null
        const retrying = props.retryingKey === comparisonCellKey(row)
        return (
          <Button
            disabled={busy}
            onClick={() => void props.onRetry(cell)}
            size='xs'
            type='button'
            variant='ghost'
          >
            {retrying && <Spinner aria-hidden='true' />}
            {t('Retry')}
          </Button>
        )
      },
    },
  ]

  return (
    <div className='grid gap-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <StatusBadge
          copyable={false}
          label={t(COMPARISON_RUN_STATUS_LABELS[run.status])}
          pulse={run.status === 'running'}
          variant={COMPARISON_RUN_STATUS_VARIANTS[run.status]}
        />
        <span className='text-muted-foreground text-sm'>
          {t('{{models}} models x {{prompts}} prompts', {
            models: run.modelCount,
            prompts: run.promptCount,
          })}
        </span>
        <span className='text-muted-foreground text-sm tabular-nums'>
          {t('Estimated {{quota}}', {
            quota: formatLogQuota(run.estimateQuota),
          })}
        </span>
        {summary.expectedCells > 0 && (
          <span className='text-sm tabular-nums'>
            {t('Settled {{quota}}', {
              quota: formatLogQuota(summary.actualQuota),
            })}
          </span>
        )}
        {summary.hasAllCosts && (
          <span
            className={cn(
              'text-sm tabular-nums',
              difference > 0 ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {t('Difference {{quota}}', {
              quota: formatLogQuota(difference),
            })}
          </span>
        )}
        <div className='ms-auto flex items-center gap-2'>
          {props.running ? (
            <Button
              onClick={props.onStop}
              size='sm'
              type='button'
              variant='destructive'
            >
              {t('Stop run')}
            </Button>
          ) : null}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              render={
                <Button
                  disabled={props.running}
                  size='sm'
                  type='button'
                  variant='outline'
                />
              }
            >
              <Download aria-hidden='true' />
              {t('Export')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-48'>
              <DropdownMenuItem onClick={() => handleExport('csv')}>
                {t('Export as CSV')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('json')}>
                {t('Export as JSON')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('markdown')}>
                {t('Export as Markdown')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <StaticDataTable
        columns={columns}
        data={rows}
        emptyContent={t('No cells were stored for this run.')}
        getRowClassName={(row) =>
          run.baselineModel === row.model ? 'bg-primary/5' : undefined
        }
        getRowKey={(row) => `${row.promptIndex}:${row.modelIndex}`}
        tableClassName='min-w-[58rem]'
      />
    </div>
  )
}
