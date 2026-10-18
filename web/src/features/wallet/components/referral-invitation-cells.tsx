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
import { useTranslation } from 'react-i18next'

import { formatQuota, formatTimestampToDate } from '@/lib/format'

import {
  getReferralCommissionStatusLabelKeys,
  referralCommissionTotal,
} from '../lib'
import type { ReferralInvitation } from '../types'

/**
 * The commission of one invitation: the total across the recorded states and
 * the states the invitation actually has.
 */
export function ReferralCommissionCell(props: {
  invitation: ReferralInvitation
}) {
  const { t } = useTranslation()
  const statusLabelKeys = getReferralCommissionStatusLabelKeys(props.invitation)
  return (
    <div>
      <div className='font-mono tabular-nums'>
        {formatQuota(referralCommissionTotal(props.invitation))}
      </div>
      {statusLabelKeys.length > 0 ? (
        <div className='text-muted-foreground text-xs'>
          {statusLabelKeys.map((key) => t(key)).join(' · ')}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Until when the invitation keeps producing commissions, from the configured
 * trigger window: a date, "no expiry" or "first top-up only".
 */
export function ReferralValidityCell(props: {
  invitation: ReferralInvitation
  windowMonths: number
}) {
  const { t } = useTranslation()
  if (props.windowMonths === -1) {
    return <span className='text-muted-foreground'>{t('No expiry')}</span>
  }
  if (props.windowMonths === 0) {
    return (
      <span className='text-muted-foreground'>{t('First top-up only')}</span>
    )
  }
  if (props.invitation.commission_ends_at <= 0) {
    return <span className='text-muted-foreground'>-</span>
  }
  return (
    <span>{formatTimestampToDate(props.invitation.commission_ends_at)}</span>
  )
}
