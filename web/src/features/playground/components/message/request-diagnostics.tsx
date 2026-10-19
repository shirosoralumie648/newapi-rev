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

import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { RequestTimingBreakdown } from '@/features/usage-logs/components/request-timing-breakdown'
import { formatBillingCurrencyFromUSD } from '@/lib/currency'
import { formatLogQuota, formatNumber } from '@/lib/format'

import { formatMessageDuration, getMessageCacheUsage } from '../../lib'
import type { MessageAlignment } from '../../lib'
import type { PlaygroundMessageCost } from '../../types'

type DiagnosticRow = { key: string; label: string; value: string }

/**
 * Read-only diagnostics of one settled request: the server-side phase timing,
 * the channel the viewer may see, the applied group ratio, the cached prompt
 * tokens with their estimated saving and the settled quota. Every figure is
 * copied from the consume log; nothing is reserved or recalculated here.
 */
export function RequestDiagnosticsPopover(props: {
  alignment: MessageAlignment
  cost: PlaygroundMessageCost
  /** Anonymous arena groups omit the serving channel entirely. */
  hideChannel?: boolean
  locale: Intl.LocalesArgument
}) {
  const { t } = useTranslation()
  const timing = props.cost.timing
  const firstToken = timing?.first_token_ms
  const duration = formatMessageDuration(firstToken ?? timing?.total_ms, t)
  const triggerLabel = duration
    ? `${firstToken === undefined ? t('Total') : t('First token')}: ${duration}`
    : t('Request diagnostics')

  const rows: DiagnosticRow[] = []
  const channelName = props.cost.channelName?.trim()
  const channelValue = [channelName, props.cost.channelKey]
    .filter(Boolean)
    .join(' · ')
  if (channelValue && !props.hideChannel) {
    rows.push({ key: 'channel', label: t('Channel'), value: channelValue })
  }
  const groupRatio = props.cost.groupRatio
  if (
    typeof groupRatio === 'number' &&
    Number.isFinite(groupRatio) &&
    groupRatio !== 1
  ) {
    rows.push({
      key: 'group-ratio',
      label: t('Group ratio'),
      value: `×${formatNumber(groupRatio, props.locale)}`,
    })
  }
  const cache = getMessageCacheUsage(props.cost)
  if (cache) {
    rows.push({
      key: 'cache-tokens',
      label: t('Cached tokens'),
      value: formatNumber(cache.tokens, props.locale),
    })
    if (cache.savingsUSD !== undefined) {
      rows.push({
        key: 'cache-savings',
        label: t('Cache savings'),
        value: `${formatBillingCurrencyFromUSD(cache.savingsUSD, {
          digitsLarge: 4,
          digitsSmall: 6,
        })} (${t('Estimated')})`,
      })
    }
  }
  rows.push({
    key: 'settled-quota',
    label: t('Settled quota'),
    value: formatLogQuota(props.cost.quota),
  })

  return (
    <Popover>
      <PopoverTrigger
        className='cursor-help underline decoration-dotted underline-offset-2'
        delay={0}
        openOnHover
      >
        {triggerLabel}
      </PopoverTrigger>
      <PopoverContent
        align={props.alignment === 'right' ? 'end' : 'start'}
        className='w-64 gap-2'
      >
        <PopoverTitle className='text-xs'>
          {t('Request diagnostics')}
        </PopoverTitle>
        {timing && <RequestTimingBreakdown timing={timing} />}
        <div className='flex flex-col gap-0.5 text-xs'>
          {rows.map((row) => (
            <div
              className='flex items-baseline justify-between gap-3'
              key={row.key}
            >
              <span className='text-muted-foreground'>{row.label}</span>
              <span className='tabular-nums'>{row.value}</span>
            </div>
          ))}
        </div>
        <PopoverDescription className='text-[11px]'>
          {t('From the settled consume log')}
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}
