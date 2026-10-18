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
import { AlertTriangle, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import type { StaticDataTableColumn } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { formatQuota, formatTimestampToDate } from '@/lib/format'

import { getReferralSourceLabelKey } from '../lib'
import type { ReferralInvitation } from '../types'
import {
  ReferralCommissionCell,
  ReferralValidityCell,
} from './referral-invitation-cells'

interface ReferralInvitationTableProps {
  /** The masked invitees of the current page, already loaded. */
  invitations: ReferralInvitation[]
  /** 0 = first paid order only, -1 = no expiry, otherwise months from sign-up. */
  windowMonths: number
  isLoading: boolean
  isError: boolean
}

/**
 * The caller's read-only invitation list: every invited account stays visible,
 * including those without a commission event yet, and only masked identifiers
 * are shown. Shared by the wallet dialog and the referral program page.
 */
export function ReferralInvitationTable(props: ReferralInvitationTableProps) {
  const { t } = useTranslation()

  const columns: StaticDataTableColumn<ReferralInvitation>[] = [
    {
      id: 'invitee',
      header: t('Invitee'),
      cell: (invitation) => (
        <span className='font-mono'>
          {invitation.identifier || `#${invitation.invitee_id}`}
        </span>
      ),
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
          windowMonths={props.windowMonths}
        />
      ),
    },
  ]

  if (props.isLoading) {
    return <LoadingState className='min-h-[220px]' />
  }
  if (props.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t('Failed to load referral invitations')}
        description={t('Something went wrong!')}
        className='min-h-[220px]'
      />
    )
  }
  if (props.invitations.length === 0) {
    return (
      <EmptyState
        icon={Share2}
        title={t('No invitees yet')}
        description={t(
          'Accounts that join through your invitation will appear here.'
        )}
        className='min-h-[220px]'
      />
    )
  }
  return (
    <StaticDataTable<ReferralInvitation>
      columns={columns}
      data={props.invitations}
      getRowKey={(invitation) => invitation.invitee_id}
    />
  )
}
