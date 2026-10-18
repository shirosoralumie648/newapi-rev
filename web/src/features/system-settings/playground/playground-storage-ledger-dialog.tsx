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
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Scale,
  ScrollText,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { StaticDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toIntlLocale } from '@/i18n/languages'
import { formatBytes, formatQuota } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'

import { usePlaygroundStorageLedger } from '../hooks/use-playground-storage-ledger'
import {
  exportPlaygroundStorageLedgerCsv,
  reconcilePlaygroundStorageBilling,
  type PlaygroundStorageLedgerDay,
  type PlaygroundStorageReconciliationReport,
} from './api'

// The server statuses of one storage billing day; the keys double as i18n keys
// and are registered in the static key list.
const STORAGE_LEDGER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  settled: 'Settled',
  grace: 'Grace',
}

const PLAYGROUND_STORAGE_LEDGER_PAGE_SIZE_ITEMS = [
  { value: '20', label: '20 / page' },
  { value: '50', label: '50 / page' },
  { value: '100', label: '100 / page' },
] as const

export function PlaygroundStorageLedgerDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [userIdFilter, setUserIdFilter] = useState('')
  const [exporting, setExporting] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [report, setReport] =
    useState<PlaygroundStorageReconciliationReport | null>(null)

  const parsedUserId = Number.parseInt(userIdFilter.trim(), 10)
  const filters = {
    userId:
      userIdFilter.trim() !== '' && Number.isFinite(parsedUserId)
        ? parsedUserId
        : undefined,
    start: start || undefined,
    end: end || undefined,
  }

  const query = usePlaygroundStorageLedger({
    userId: filters.userId,
    start: filters.start,
    end: filters.end,
    page,
    pageSize,
    enabled: props.open,
  })

  useEffect(() => {
    if (props.open) {
      setPage(1)
    }
  }, [props.open])

  const days = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const resetPage = () => setPage(1)

  const handleExport = async () => {
    setExporting(true)
    try {
      const blob = await exportPlaygroundStorageLedgerCsv(filters)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'playground-storage-ledger.csv'
      anchor.click()
      URL.revokeObjectURL(url)
      toast.success(t('Storage ledger exported'))
    } catch (error) {
      handleServerError(error, t('Failed to export the storage ledger'))
    } finally {
      setExporting(false)
    }
  }

  const handleReconcile = async () => {
    setReconciling(true)
    try {
      setReport(await reconcilePlaygroundStorageBilling(filters.userId))
    } catch (error) {
      handleServerError(error, t('Failed to reconcile the storage ledger'))
    } finally {
      setReconciling(false)
    }
  }

  const columns = [
    {
      id: 'date',
      header: t('Date'),
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span className='tabular-nums'>{day.date}</span>
      ),
    },
    {
      id: 'user',
      header: t('User'),
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span className='tabular-nums'>#{day.user_id}</span>
      ),
    },
    {
      id: 'peak',
      header: t('Peak'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span className='font-mono tabular-nums'>
          {formatBytes(day.peak_bytes, locale)}
        </span>
      ),
    },
    {
      id: 'billable',
      header: t('Billed'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span className='font-mono tabular-nums'>
          {formatBytes(day.billable_bytes, locale)}
        </span>
      ),
    },
    {
      id: 'egress',
      header: t('Egress'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span className='font-mono tabular-nums'>
          {formatBytes(day.egress_bytes, locale)}
        </span>
      ),
    },
    {
      id: 'charge',
      header: t('Charge'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span className='font-mono tabular-nums'>{formatQuota(day.quota)}</span>
      ),
    },
    {
      id: 'debt',
      header: t('Debt'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (day: PlaygroundStorageLedgerDay) => (
        <span
          className={cn(
            'font-mono tabular-nums',
            day.debt_quota > 0 && 'text-destructive'
          )}
        >
          {formatQuota(day.debt_quota)}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('Status'),
      cell: (day: PlaygroundStorageLedgerDay) =>
        t(STORAGE_LEDGER_STATUS_LABELS[day.status] ?? day.status),
    },
  ]

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Storage ledger')}
      description={t(
        'Daily metered storage charges, their free allowance and the wallet debt they raised'
      )}
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-5xl'
      contentHeight='auto'
      bodyClassName='space-y-3'
      footer={
        <div className='flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <div className='text-muted-foreground text-xs sm:text-sm'>
            {total > 0 &&
              `${t('Showing')} ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} ${t('of')} ${total}`}
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Select
              items={PLAYGROUND_STORAGE_LEDGER_PAGE_SIZE_ITEMS.map((item) => ({
                value: item.value,
                label: t(item.label),
              }))}
              value={pageSize.toString()}
              onValueChange={(value) => {
                if (value === null) return
                setPageSize(Number.parseInt(value))
                setPage(1)
              }}
            >
              <SelectTrigger
                className='h-8 w-[92px] sm:w-32'
                aria-label={t('Page size')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {PLAYGROUND_STORAGE_LEDGER_PAGE_SIZE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {t(item.label)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant='outline'
              size='sm'
              aria-label={t('Go to previous page')}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className='h-8 w-8 p-0'
            >
              <ChevronLeft className='h-4 w-4' />
            </Button>
            <span
              className='text-muted-foreground text-sm tabular-nums'
              aria-live='polite'
            >
              {page} / {totalPages}
            </span>
            <Button
              variant='outline'
              size='sm'
              aria-label={t('Go to next page')}
              onClick={() => setPage((current) => current + 1)}
              disabled={page >= totalPages}
              className='h-8 w-8 p-0'
            >
              <ChevronRight className='h-4 w-4' />
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='gap-2'
              onClick={handleExport}
              disabled={exporting || total === 0}
            >
              <Download className='h-4 w-4' />
              {exporting ? t('Exporting...') : t('Export CSV')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='gap-2'
              onClick={handleReconcile}
              disabled={reconciling}
            >
              <Scale className='h-4 w-4' />
              {reconciling ? t('Reconciling...') : t('Reconcile')}
            </Button>
          </div>
        </div>
      }
    >
      <div className='min-h-0 space-y-3'>
        <div className='flex flex-wrap items-end gap-3'>
          <div className='flex min-w-36 flex-1 flex-col gap-1.5'>
            <Label htmlFor='playground-storage-filter-start'>
              {t('Start date')}
            </Label>
            <Input
              id='playground-storage-filter-start'
              onChange={(event) => {
                setStart(event.target.value)
                resetPage()
              }}
              type='date'
              value={start}
            />
          </div>
          <div className='flex min-w-36 flex-1 flex-col gap-1.5'>
            <Label htmlFor='playground-storage-filter-end'>
              {t('End date')}
            </Label>
            <Input
              id='playground-storage-filter-end'
              onChange={(event) => {
                setEnd(event.target.value)
                resetPage()
              }}
              type='date'
              value={end}
            />
          </div>
          <div className='flex min-w-36 flex-1 flex-col gap-1.5'>
            <Label htmlFor='playground-storage-filter-user'>
              {t('User ID')}
            </Label>
            <Input
              id='playground-storage-filter-user'
              inputMode='numeric'
              min={1}
              onChange={(event) => {
                setUserIdFilter(event.target.value)
                resetPage()
              }}
              placeholder={t('All accounts')}
              type='number'
              value={userIdFilter}
            />
          </div>
        </div>
        {report && (
          <p className='text-muted-foreground text-xs'>
            {report.deviation_count === 0
              ? t('Storage charges match the wallet ledger.')
              : t(
                  'Found {{count}} accounts whose storage charges deviate from the wallet ledger.',
                  { count: report.deviation_count }
                )}
          </p>
        )}
        {query.isLoading ? (
          <LoadingState className='min-h-[220px]' />
        ) : query.isError ? (
          <EmptyState
            icon={ScrollText}
            title={t('Failed to load the storage ledger')}
            description={t('Something went wrong!')}
            className='min-h-[220px]'
          />
        ) : days.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={t('No storage ledger entries found')}
            description={t('Daily storage charges will appear here')}
            className='min-h-[220px]'
          />
        ) : (
          <StaticDataTable<PlaygroundStorageLedgerDay>
            columns={columns}
            data={days}
            getRowKey={(day) => day.id}
          />
        )}
      </div>
    </Dialog>
  )
}
