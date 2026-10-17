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
import { ChevronLeft, ChevronRight, Download, ScrollText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { StaticDataTable } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatQuota, formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'

import { exportWalletLedgerCsv } from '../api'
import { useWalletLedger } from '../hooks'
import { getWalletLedgerKindLabel } from '../lib/ledger'
import type { WalletLedgerEntry } from '../types'

interface WalletLedgerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Admin target user; omitted shows the caller's own ledger. */
  userId?: number
  username?: string
}

const WALLET_LEDGER_PAGE_SIZE_ITEMS = [
  { value: '10', label: '10 / page' },
  { value: '20', label: '20 / page' },
  { value: '50', label: '50 / page' },
  { value: '100', label: '100 / page' },
] as const

export function WalletLedgerDialog(props: WalletLedgerDialogProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [exporting, setExporting] = useState(false)

  const query = useWalletLedger({
    userId: props.userId,
    page,
    pageSize,
    enabled: props.open,
  })

  useEffect(() => {
    if (props.open) {
      setPage(1)
    }
  }, [props.open])

  const entries = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const handleExport = async () => {
    setExporting(true)
    try {
      const blob = await exportWalletLedgerCsv(props.userId)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = props.userId
        ? `wallet-ledger-${props.userId}.csv`
        : 'wallet-ledger.csv'
      anchor.click()
      URL.revokeObjectURL(url)
      toast.success(t('Wallet ledger exported'))
    } catch (error) {
      handleServerError(error, t('Failed to export wallet ledger'))
    } finally {
      setExporting(false)
    }
  }

  const columns = [
    {
      id: 'time',
      header: t('Time'),
      cell: (entry: WalletLedgerEntry) =>
        formatTimestampToDate(entry.created_at),
    },
    {
      id: 'kind',
      header: t('Type'),
      cell: (entry: WalletLedgerEntry) =>
        t(getWalletLedgerKindLabel(entry.kind)),
    },
    {
      id: 'amount',
      header: t('Amount'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (entry: WalletLedgerEntry) => {
        const credit = entry.amount >= 0
        return (
          <span
            className={cn(
              'font-mono tabular-nums',
              credit ? 'text-success' : 'text-destructive'
            )}
          >
            {credit ? '+' : '-'}
            {formatQuota(Math.abs(entry.amount))}
          </span>
        )
      },
    },
    {
      id: 'balance',
      header: t('Balance After'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (entry: WalletLedgerEntry) => (
        <span className='font-mono tabular-nums'>
          {formatQuota(entry.balance_after)}
        </span>
      ),
    },
    {
      id: 'reference',
      header: t('Reference'),
      cell: (entry: WalletLedgerEntry) => (
        <code className='text-muted-foreground font-mono text-xs'>
          {entry.ref_id}
        </code>
      ),
    },
  ]

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Wallet Ledger')}
      description={
        props.username
          ? t('Wallet ledger of {{username}}', { username: props.username })
          : t('Read-only history of wallet balance changes')
      }
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-3xl'
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
              items={WALLET_LEDGER_PAGE_SIZE_ITEMS.map((item) => ({
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
                  {WALLET_LEDGER_PAGE_SIZE_ITEMS.map((item) => (
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
          </div>
        </div>
      }
    >
      <div className='min-h-0 space-y-3'>
        {query.isLoading ? (
          <LoadingState className='min-h-[220px]' />
        ) : query.isError ? (
          <EmptyState
            icon={ScrollText}
            title={t('Failed to load wallet ledger')}
            description={t('Something went wrong!')}
            className='min-h-[220px]'
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={t('No ledger entries found')}
            description={t('Wallet balance changes will appear here')}
            className='min-h-[220px]'
          />
        ) : (
          <StaticDataTable<WalletLedgerEntry>
            columns={columns}
            data={entries}
            getRowKey={(entry) => entry.id}
          />
        )}
      </div>
    </Dialog>
  )
}
