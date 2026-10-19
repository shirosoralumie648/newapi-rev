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

import { toIntlLocale } from '@/i18n/languages'
import {
  formatBillingCurrencyFromUSD,
  formatQuotaWithCurrency,
} from '@/lib/currency'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

import type { PlaygroundCostEstimate } from '../../lib'

interface PlaygroundCostStatusProps {
  estimate: PlaygroundCostEstimate
  className?: string
}

/**
 * The estimated cost of the next send, shown beside the context status. The
 * amount is always an estimate: it is computed from the model's read-only
 * pricing and the current input, while the settled amount is only known from
 * the consumption logs. Models without a usable price degrade to translated
 * text instead of an invented amount.
 */
export function PlaygroundCostStatus(props: PlaygroundCostStatusProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const balanceQuota = useAuthStore((state) => state.auth.user?.quota)
  const estimate = props.estimate

  if (estimate.promptTokens === 0) {
    return null
  }

  const renderEstimate = () => {
    if (estimate.status === 'estimated') {
      return (
        <span>
          {t('≈{{amount}} (estimated)', {
            amount: formatBillingCurrencyFromUSD(estimate.amountUSD),
          })}
          {estimate.billingUnit === 'request' && ` ${t('per request')}`}
        </span>
      )
    }
    if (estimate.status === 'missing-cache-price') {
      return (
        <span className='text-amber-600 dark:text-amber-400' role='status'>
          {t('Cached input pricing is not configured.')}
        </span>
      )
    }
    if (estimate.reason === 'expression') {
      return (
        <span className='text-amber-600 dark:text-amber-400' role='status'>
          {t('This model is priced by usage.')}
        </span>
      )
    }
    return (
      <span className='text-amber-600 dark:text-amber-400' role='status'>
        {t('No price is configured for this model.')}
      </span>
    )
  }

  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs',
        props.className
      )}
    >
      {renderEstimate()}
      <span>{t('Final amount is in the consumption logs.')}</span>
      {estimate.status === 'estimated' && estimate.groupRatio !== 1 && (
        <span>
          {t('Group ratio {{ratio}}', {
            ratio: formatNumber(estimate.groupRatio, locale),
          })}
        </span>
      )}
      {typeof balanceQuota === 'number' && Number.isFinite(balanceQuota) && (
        <span>
          {t('Balance {{balance}}', {
            balance: formatQuotaWithCurrency(balanceQuota),
          })}
        </span>
      )}
      {estimate.exceedsContext && (
        <span className='text-amber-600 dark:text-amber-400' role='status'>
          {t("The input exceeds this model's context window.")}
        </span>
      )}
    </div>
  )
}
