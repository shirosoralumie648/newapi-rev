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
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import type { StaticDataTableColumn } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { formatQuota, formatTimestampToDate } from '@/lib/format'

import { useWalletDebtors } from '../../hooks'
import type { WalletDebtor } from '../../types'

interface WalletDebtDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Admin action shown for one debtor row; omitted hides the column. */
  onOpenLedger?: (debtor: WalletDebtor) => void
}

const WALLET_DEBT_PAGE_SIZE = 20

/**
 * Administrative view of every account whose wallet has unsettled debt, with
 * the owed amount and the balance it was charged against.
 */
export function WalletDebtDialog(props: WalletDebtDialogProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)

  const query = useWalletDebtors(page, WALLET_DEBT_PAGE_SIZE, props.open)

  useEffect(() => {
    if (props.open) {
      setPage(1)
    }
  }, [props.open])

  const debtors = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / WALLET_DEBT_PAGE_SIZE))
  const totalDebt = debtors.reduce((sum, debtor) => sum + debtor.debt, 0)

  const columns: StaticDataTableColumn<WalletDebtor>[] = [
    {
      id: 'user',
      header: t('User'),
      cell: (debtor: WalletDebtor) => debtor.username || `#${debtor.user_id}`,
    },
    {
      id: 'group',
      header: t('Group'),
      cell: (debtor: WalletDebtor) => debtor.group || '-',
    },
    {
      id: 'balance',
      header: t('Balance'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (debtor: WalletDebtor) => (
        <span className='font-mono tabular-nums'>
          {formatQuota(debtor.quota)}
        </span>
      ),
    },
    {
      id: 'debt',
      header: t('Wallet Debt'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (debtor: WalletDebtor) => (
        <span className='text-destructive font-mono tabular-nums'>
          {formatQuota(debtor.debt)}
        </span>
      ),
    },
    {
      id: 'updated',
      header: t('Updated At'),
      cell: (debtor: WalletDebtor) => formatTimestampToDate(debtor.updated_at),
    },
    ...(props.onOpenLedger
      ? [
          {
            id: 'actions',
            header: '',
            className: 'text-right',
            cellClassName: 'text-right',
            cell: (debtor: WalletDebtor) => (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => props.onOpenLedger?.(debtor)}
              >
                {t('Wallet Ledger')}
              </Button>
            ),
          },
        ]
      : []),
  ]

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Wallet debts')}
      description={t('Accounts whose wallet balance is in arrears')}
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-3xl'
      contentHeight='auto'
      bodyClassName='space-y-3'
      footer={
        <div className='flex w-full items-center justify-between gap-3'>
          <div className='text-muted-foreground text-xs sm:text-sm'>
            {total > 0 &&
              `${t('{{count}} accounts in debt', { count: total })} · ${t('Outstanding debt')}: ${formatQuota(totalDebt)}`}
          </div>
          <div className='flex items-center gap-2'>
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
          </div>
        </div>
      }
    >
      <div className='min-h-0 space-y-3'>
        {query.isLoading ? (
          <LoadingState className='min-h-[220px]' />
        ) : query.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title={t('Failed to load wallet debts')}
            description={t('Something went wrong!')}
            className='min-h-[220px]'
          />
        ) : debtors.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title={t('No wallet debts')}
            description={t('No account currently owes the platform.')}
            className='min-h-[220px]'
          />
        ) : (
          <StaticDataTable<WalletDebtor>
            columns={columns}
            data={debtors}
            getRowKey={(debtor) => debtor.user_id}
          />
        )}
      </div>
    </Dialog>
  )
}
