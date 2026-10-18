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
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Share2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { StaticDataTable } from '@/components/data-table'
import type { StaticDataTableColumn } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDebounce } from '@/hooks'
import { formatQuota, formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import { exportReferralInvitationsCsv } from '../../api'
import { useReferralInvitations } from '../../hooks'
import {
  EMPTY_REFERRAL_STATS_SUMMARY,
  REFERRAL_COMMISSION_STATUS_FILTER_VALUES,
  REFERRAL_COMMISSION_STATUS_LABEL_KEYS,
  REFERRAL_SOURCE_FILTER_VALUES,
  getReferralSourceLabelKey,
} from '../../lib'
import type { ReferralInvitation } from '../../types'
import {
  ReferralCommissionCell,
  ReferralValidityCell,
} from '../referral-invitation-cells'

interface ReferralAdminDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const REFERRAL_ADMIN_PAGE_SIZE = 20
const ALL_FILTER_VALUE = 'all'

/**
 * Administrative referral statistics: the platform-wide invitation list with
 * filter-aware summary, filters and a CSV export. Read-only.
 */
export function ReferralAdminDialog(props: ReferralAdminDialogProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('')
  const [exporting, setExporting] = useState(false)
  const debouncedKeyword = useDebounce(keyword, 300)

  useEffect(() => {
    if (props.open) {
      setPage(1)
    }
  }, [props.open])

  useEffect(() => {
    setPage(1)
  }, [debouncedKeyword, source, status])

  const query = useReferralInvitations(
    page,
    REFERRAL_ADMIN_PAGE_SIZE,
    { keyword: debouncedKeyword, source, status },
    props.open
  )

  const invitations = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const windowMonths = query.data?.window_months ?? 0
  const summary = query.data?.summary ?? EMPTY_REFERRAL_STATS_SUMMARY
  const totalPages = Math.max(1, Math.ceil(total / REFERRAL_ADMIN_PAGE_SIZE))

  const sourceItems = [
    { value: ALL_FILTER_VALUE, label: t('All') },
    ...REFERRAL_SOURCE_FILTER_VALUES.map((value) => ({
      value,
      label: t(getReferralSourceLabelKey(value)),
    })),
  ]
  const statusItems = [
    { value: ALL_FILTER_VALUE, label: t('All') },
    ...REFERRAL_COMMISSION_STATUS_FILTER_VALUES.map((value) => ({
      value,
      label: t(REFERRAL_COMMISSION_STATUS_LABEL_KEYS[value]),
    })),
  ]

  const handleExport = async () => {
    setExporting(true)
    try {
      const blob = await exportReferralInvitationsCsv({
        keyword: debouncedKeyword,
        source,
        status,
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'referral-invitations.csv'
      anchor.click()
      URL.revokeObjectURL(url)
      toast.success(t('Referral invitations exported'))
    } catch (error) {
      handleServerError(error, t('Failed to export referral invitations'))
    } finally {
      setExporting(false)
    }
  }

  const columns: StaticDataTableColumn<ReferralInvitation>[] = [
    {
      id: 'invitee',
      header: t('Invitee'),
      cell: (invitation) => (
        <div className='min-w-0'>
          <div className='truncate font-medium'>
            {invitation.username ||
              invitation.email ||
              `#${invitation.invitee_id}`}
          </div>
          {invitation.username && invitation.email ? (
            <div className='text-muted-foreground truncate text-xs'>
              {invitation.email}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'inviter',
      header: t('Inviter'),
      cell: (invitation) =>
        invitation.inviter_username || `#${invitation.inviter_id ?? '-'}`,
    },
    {
      id: 'source',
      header: t('Source'),
      cell: (invitation) => t(getReferralSourceLabelKey(invitation.source)),
    },
    {
      id: 'bound',
      header: t('Bound At'),
      cell: (invitation) => formatTimestampToDate(invitation.bound_at),
    },
    {
      id: 'paid',
      header: t('Paid'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (invitation) => (
        <span className='font-mono tabular-nums'>
          {formatQuota(invitation.total_paid_quota)}
        </span>
      ),
    },
    {
      id: 'commission',
      header: t('Commission'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (invitation) => <ReferralCommissionCell invitation={invitation} />,
    },
    {
      id: 'validity',
      header: t('Validity'),
      cell: (invitation) => (
        <ReferralValidityCell
          invitation={invitation}
          windowMonths={windowMonths}
        />
      ),
    },
  ]

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Referral Invitations')}
      description={t(
        'Read-only list of every recorded invitation and its commission totals'
      )}
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-5xl'
      contentHeight='auto'
      bodyClassName='space-y-3'
      footer={
        <div className='flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <div className='text-muted-foreground text-xs sm:text-sm'>
            {total > 0 && t('{{count}} invitees', { count: total })}
          </div>
          <div className='flex flex-wrap items-center gap-2'>
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
        <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
          {[
            [t('Invitees'), String(summary.total_invitees)],
            [
              t('Invitees with commissions'),
              String(summary.invitees_with_commission),
            ],
            [t('Total Paid'), formatQuota(summary.total_paid_quota)],
            [
              t('Total Commission'),
              formatQuota(summary.total_commission_quota),
            ],
          ].map(([label, value]) => (
            <div key={label} className='bg-muted/40 rounded-lg px-3 py-2'>
              <div className='text-muted-foreground truncate text-xs'>
                {label}
              </div>
              <div className='mt-0.5 truncate font-mono text-sm font-semibold tabular-nums'>
                {value}
              </div>
            </div>
          ))}
        </div>
        <p className='text-muted-foreground text-xs'>
          {t('Pending')}: {formatQuota(summary.pending_quota)} · {t('Locked')}:{' '}
          {formatQuota(summary.locked_quota)} · {t('Settled')}:{' '}
          {formatQuota(summary.settled_quota)}
        </p>
        {query.data && !query.data.commission_enabled ? (
          <p className='text-muted-foreground text-xs'>
            {t(
              'Referral commission is disabled; recorded amounts remain listed.'
            )}
          </p>
        ) : null}
        <div className='flex flex-wrap items-center gap-2'>
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t('Search invitees')}
            aria-label={t('Search invitees')}
            className='h-8 w-full sm:w-56'
          />
          <Select
            items={sourceItems}
            value={source || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              if (value === null) return
              setSource(value === ALL_FILTER_VALUE ? '' : value)
            }}
          >
            <SelectTrigger className='h-8 w-[128px]' aria-label={t('Source')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {sourceItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            items={statusItems}
            value={status || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              if (value === null) return
              setStatus(value === ALL_FILTER_VALUE ? '' : value)
            }}
          >
            <SelectTrigger className='h-8 w-[128px]' aria-label={t('Status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {statusItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {query.isLoading ? (
          <LoadingState className='min-h-[220px]' />
        ) : query.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title={t('Failed to load referral invitations')}
            description={t('Something went wrong!')}
            className='min-h-[220px]'
          />
        ) : invitations.length === 0 ? (
          <EmptyState
            icon={Share2}
            title={t('No invitees yet')}
            description={t(
              'Accounts that join through a referral invitation will appear here.'
            )}
            className='min-h-[220px]'
          />
        ) : (
          <StaticDataTable<ReferralInvitation>
            columns={columns}
            data={invitations}
            getRowKey={(invitation) => invitation.invitee_id}
          />
        )}
      </div>
    </Dialog>
  )
}
