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
import { Gift } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { IconBadge } from '@/components/ui/icon-badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatNumber, formatQuota, formatTimestampToDate } from '@/lib/format'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { useCreditGrantStats, useSelfCreditGrants } from '../hooks'
import { getCreditGrantSourceLabel } from '../lib/credit-grant'
import type {
  CreditGrantBucket,
  CreditGrantSourceStats,
  CreditGrantStats,
} from '../types'

/**
 * The wallet buckets of the signed-in account: the paid balance that never
 * expires, the granted credit still spendable with its expiry, and the credit
 * that already expired. Administrators additionally see the platform totals by
 * grant source, because they audit what was granted, consumed and refunded.
 */
export function CreditGrantCard() {
  const { t } = useTranslation()
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  const isAdmin = role >= ROLE.ADMIN
  const wallet = useSelfCreditGrants()
  const stats = useCreditGrantStats(isAdmin)

  const view = wallet.data
  const buckets = view?.grants ?? []

  const bucketColumns = [
    {
      id: 'source',
      header: t('Grant source'),
      cell: (bucket: CreditGrantBucket) =>
        t(getCreditGrantSourceLabel(bucket.source)),
    },
    {
      id: 'remaining',
      header: t('Remaining'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (bucket: CreditGrantBucket) => (
        <span className='font-mono tabular-nums'>
          {formatQuota(bucket.remaining)}
        </span>
      ),
    },
    {
      id: 'expires',
      header: t('Expires'),
      cell: (bucket: CreditGrantBucket) =>
        bucket.expires_at > 0
          ? formatTimestampToDate(bucket.expires_at)
          : t('Never expires'),
    },
  ]

  return (
    <div className='rounded-lg border'>
      <div className='flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5'>
        <div className='flex items-center gap-2.5'>
          <IconBadge tone='info' size='stat'>
            <Gift aria-hidden='true' />
          </IconBadge>
          <div>
            <div className='text-sm font-medium'>{t('Credit grants')}</div>
            <p className='text-muted-foreground text-xs sm:text-sm'>
              {t(
                'Granted credit is spent before the paid balance and stops being usable at its expiry.'
              )}
            </p>
          </div>
        </div>
      </div>

      <div className='space-y-4 px-4 py-4 sm:px-5'>
        {wallet.isLoading ? (
          <div className='grid grid-cols-3 divide-x rounded-lg border'>
            {['paid', 'granted', 'expired'].map((key) => (
              <div key={key} className='min-w-0 px-2.5 py-2.5 sm:px-5 sm:py-4'>
                <Skeleton className='h-3.5 w-full' />
                <Skeleton className='mt-2 h-6 w-full' />
              </div>
            ))}
          </div>
        ) : wallet.isError || !view ? (
          <EmptyState
            icon={Gift}
            title={t('Failed to load credit grants')}
            description={t('Something went wrong!')}
          />
        ) : (
          <>
            <div className='grid grid-cols-3 divide-x rounded-lg border'>
              <BucketStat
                label={t('Paid balance')}
                value={formatQuota(view.paid_quota)}
                description={t('Top-ups only, never expires')}
              />
              <BucketStat
                label={t('Granted credit')}
                value={formatQuota(view.grant_quota)}
                description={t('Spent before the paid balance')}
              />
              <BucketStat
                label={t('Expired credit')}
                value={formatQuota(view.expired_quota)}
                description={t('Expired and no longer usable')}
              />
            </div>

            {buckets.length === 0 ? (
              <EmptyState
                icon={Gift}
                title={t('No credit grants')}
                description={t(
                  'Sign-in rewards, invitation rewards, redemption codes and administrator gifts appear here.'
                )}
                className='min-h-[160px]'
              />
            ) : (
              <StaticDataTable<CreditGrantBucket>
                columns={bucketColumns}
                data={buckets}
                getRowKey={(bucket) => bucket.grant_id}
              />
            )}
          </>
        )}

        {isAdmin && (
          <AdminTotals stats={stats.data ?? null} loading={stats.isLoading} />
        )}
      </div>
    </div>
  )
}

function BucketStat(props: {
  label: string
  value: string
  description: string
}) {
  return (
    <div className='min-w-0 px-2.5 py-2.5 sm:px-5 sm:py-4'>
      <div className='text-muted-foreground truncate text-[11px] font-medium tracking-wider uppercase sm:text-xs'>
        {props.label}
      </div>
      <div className='text-foreground mt-1.5 font-mono text-sm font-bold tracking-tight break-all tabular-nums sm:mt-2.5 sm:text-xl'>
        {props.value}
      </div>
      <div className='text-muted-foreground/60 mt-1 hidden text-xs md:block'>
        {props.description}
      </div>
    </div>
  )
}

/**
 * Platform totals by grant source, shown to administrators only: the endpoint
 * behind it requires the user:read capability.
 */
function AdminTotals(props: {
  stats: CreditGrantStats | null
  loading: boolean
}) {
  const { t } = useTranslation()

  const columns = [
    {
      id: 'source',
      header: t('Grant source'),
      cell: (entry: CreditGrantSourceStats) =>
        t(getCreditGrantSourceLabel(entry.source)),
    },
    {
      id: 'granted',
      header: t('Total granted'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (entry: CreditGrantSourceStats) => formatQuota(entry.granted),
    },
    {
      id: 'spent',
      header: t('Total spent'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (entry: CreditGrantSourceStats) => formatQuota(entry.spent),
    },
    {
      id: 'remaining',
      header: t('Remaining'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (entry: CreditGrantSourceStats) => formatQuota(entry.remaining),
    },
    {
      id: 'accounts',
      header: t('Accounts'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (entry: CreditGrantSourceStats) => formatNumber(entry.accounts),
    },
  ]

  return (
    <div className='space-y-3 border-t pt-4'>
      <div className='text-sm font-medium'>{t('Wallet totals')}</div>
      {props.loading ? (
        <Skeleton className='h-24 w-full' />
      ) : props.stats === null ? (
        <EmptyState
          icon={Gift}
          title={t('Failed to load credit grants')}
          description={t('Something went wrong!')}
        />
      ) : (
        <>
          <div className='grid grid-cols-2 divide-x divide-y rounded-lg border sm:grid-cols-4 sm:divide-y-0'>
            <BucketStat
              label={t('Total top-up')}
              value={formatQuota(props.stats.total_topup)}
              description={t('Paid balance credited')}
            />
            <BucketStat
              label={t('Total granted')}
              value={formatQuota(props.stats.total_granted)}
              description={t('Grant-typed credit issued')}
            />
            <BucketStat
              label={t('Total consumed')}
              value={formatQuota(props.stats.total_consumed)}
              description={t('Wallet consumption')}
            />
            <BucketStat
              label={t('Total refunded')}
              value={formatQuota(props.stats.total_refunded)}
              description={t('Returned to wallets')}
            />
          </div>
          {props.stats.sources.length > 0 && (
            <StaticDataTable<CreditGrantSourceStats>
              columns={columns}
              data={props.stats.sources}
              getRowKey={(entry) => entry.source}
            />
          )}
        </>
      )}
    </div>
  )
}
