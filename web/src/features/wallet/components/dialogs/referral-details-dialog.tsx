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
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'

import { useSelfReferralInvitations } from '../../hooks'
import { ReferralInvitationTable } from '../referral-invitation-table'

interface ReferralDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const REFERRAL_INVITATIONS_PAGE_SIZE = 20

/**
 * Read-only list of the caller's invitees: every invited account stays
 * visible, including those without a commission event yet, and only masked
 * identifiers are shown.
 */
export function ReferralDetailsDialog(props: ReferralDetailsDialogProps) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)

  const query = useSelfReferralInvitations(
    page,
    REFERRAL_INVITATIONS_PAGE_SIZE,
    props.open
  )

  useEffect(() => {
    if (props.open) {
      setPage(1)
    }
  }, [props.open])

  const invitations = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const windowMonths = query.data?.window_months ?? 0
  const totalPages = Math.max(
    1,
    Math.ceil(total / REFERRAL_INVITATIONS_PAGE_SIZE)
  )

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Referral Invitations')}
      description={t(
        'Accounts that joined through your invitation, with partially masked account names'
      )}
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-3xl'
      contentHeight='auto'
      bodyClassName='space-y-3'
      footer={
        <div className='flex w-full items-center justify-between gap-3'>
          <div className='text-muted-foreground text-xs sm:text-sm'>
            {total > 0 && t('{{count}} invitees', { count: total })}
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
        {query.data && !query.data.commission_enabled ? (
          <p className='text-muted-foreground text-xs'>
            {t(
              'Referral commission is disabled; recorded amounts remain listed.'
            )}
          </p>
        ) : null}
        <ReferralInvitationTable
          invitations={invitations}
          windowMonths={windowMonths}
          isLoading={query.isLoading}
          isError={query.isError}
        />
      </div>
    </Dialog>
  )
}
