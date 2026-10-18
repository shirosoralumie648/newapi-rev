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
  ShieldCheck,
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
import { formatQuota, formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import {
  useDecideReferralCommissionReview,
  useReferralCommissionReviews,
} from '../../hooks'
import {
  getReferralCommissionReasonLabelKey,
  getReferralSourceLabelKey,
} from '../../lib'
import type {
  ReferralCommissionRecord,
  ReferralReviewDecision,
} from '../../types'

interface ReferralReviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const REFERRAL_REVIEW_PAGE_SIZE = 20

/**
 * The manual review queue: commission events above the configured threshold
 * or involving a watched account wait here until an administrator approves or
 * rejects them. A rejected event never becomes payable.
 */
export function ReferralReviewDialog(props: ReferralReviewDialogProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [decidingId, setDecidingId] = useState<number | null>(null)

  useEffect(() => {
    if (props.open) {
      setPage(1)
    }
  }, [props.open])

  const query = useReferralCommissionReviews(
    page,
    REFERRAL_REVIEW_PAGE_SIZE,
    props.open
  )
  const decide = useDecideReferralCommissionReview()

  const reviews = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / REFERRAL_REVIEW_PAGE_SIZE))

  const handleDecision = async (
    id: number,
    decision: ReferralReviewDecision
  ) => {
    setDecidingId(id)
    try {
      await decide.mutateAsync({ id, decision })
      toast.success(t('Referral review updated'))
    } catch (error) {
      handleServerError(error, t('Failed to update the referral review'))
    } finally {
      setDecidingId(null)
    }
  }

  const columns: StaticDataTableColumn<ReferralCommissionRecord>[] = [
    {
      id: 'id',
      header: t('Event'),
      cell: (review) => (
        <span className='font-mono tabular-nums'>#{review.id}</span>
      ),
    },
    {
      id: 'invitee',
      header: t('Invitee'),
      cell: (review) => `#${review.invitee_id}`,
    },
    {
      id: 'source',
      header: t('Source'),
      cell: (review) => t(getReferralSourceLabelKey(review.source)),
    },
    {
      id: 'commission',
      header: t('Commission'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (review) => (
        <span className='font-mono tabular-nums'>
          {formatQuota(review.commission_quota)}
        </span>
      ),
    },
    {
      id: 'reason',
      header: t('Reason'),
      cell: (review) => t(getReferralCommissionReasonLabelKey(review.reason)),
    },
    {
      id: 'created',
      header: t('Created At'),
      cell: (review) => formatTimestampToDate(review.created_at),
    },
    {
      id: 'actions',
      header: '',
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (review) => (
        <div className='flex justify-end gap-2'>
          <Button
            disabled={decide.isPending && decidingId === review.id}
            onClick={() => void handleDecision(review.id, 'approve')}
            size='sm'
            type='button'
            variant='outline'
          >
            {t('Approve')}
          </Button>
          <Button
            disabled={decide.isPending && decidingId === review.id}
            onClick={() => void handleDecision(review.id, 'reject')}
            size='sm'
            type='button'
            variant='ghost'
            className='text-destructive hover:text-destructive'
          >
            {t('Reject')}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Referral Reviews')}
      description={t(
        'Commission events above the review threshold or involving a watched account wait here for a decision'
      )}
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-4xl'
      contentHeight='auto'
      bodyClassName='space-y-3'
      footer={
        <div className='flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <div className='text-muted-foreground text-xs sm:text-sm'>
            {total > 0 && t('{{count}} events', { count: total })}
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
      {query.isLoading ? (
        <LoadingState className='min-h-[220px]' />
      ) : query.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title={t('Failed to load referral reviews')}
          description={t('Something went wrong!')}
          className='min-h-[220px]'
        />
      ) : reviews.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={t('No commissions are waiting for review')}
          description={t(
            'Commissions above the review threshold or involving a watched account appear here.'
          )}
          className='min-h-[220px]'
        />
      ) : (
        <StaticDataTable<ReferralCommissionRecord>
          columns={columns}
          data={reviews}
          getRowKey={(review) => review.id}
        />
      )}
    </Dialog>
  )
}
