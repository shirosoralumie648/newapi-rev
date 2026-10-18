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
import type { TFunction } from 'i18next'
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { RequestTimingBreakdown } from '@/features/usage-logs/components/request-timing-breakdown'
import { toIntlLocale } from '@/i18n/languages'
import { formatLogQuota, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import { getVersionUsage } from '../../lib'
import type { MessageAlignment } from '../../lib'
import type {
  Message,
  MessageUsage,
  MessageVersion,
  PlaygroundMessageCost,
} from '../../types'

type MessageMetadataProps = {
  alignment: MessageAlignment
  message: Message
  /** The rendered version; usage and cost belong to one generated version. */
  version: MessageVersion
  /** Settled consume row of this version's request, when it is loaded. */
  cost?: PlaygroundMessageCost
}

function formatMessageTime(timestamp?: number): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

function formatDuration(
  durationMs: number | undefined,
  t: TFunction
): string | undefined {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return undefined
  }

  if (durationMs < 1000) {
    return t('{{value}}ms', { value: Math.max(1, Math.round(durationMs)) })
  }

  return t('{{value}}s', { value: (durationMs / 1000).toFixed(2) })
}

// The visible text stays the reported total; the breakdown (the prompt and
// completion counts) is one hover or focus away.
function MessageUsageIndicator(props: {
  usage: MessageUsage
  locale: Intl.LocalesArgument
}) {
  const { t } = useTranslation()
  const label = t('Tokens: {{tokens}}', {
    tokens: formatNumber(props.usage.totalTokens, props.locale),
  })

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className='cursor-help underline decoration-dotted underline-offset-2'
              tabIndex={0}
            >
              {label}
            </span>
          }
        />
        <TooltipContent>
          <span className='flex flex-col items-start gap-0.5'>
            <span>
              {t('Input Tokens')}:{' '}
              {formatNumber(props.usage.promptTokens, props.locale)}
            </span>
            <span>
              {t('Output Tokens')}:{' '}
              {formatNumber(props.usage.completionTokens, props.locale)}
            </span>
            <span>
              {t('Total Tokens')}:{' '}
              {formatNumber(props.usage.totalTokens, props.locale)}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// The trigger shows the server-measured end-to-end first-token latency (or the
// total when the entry never reported a first token); the phase breakdown is
// one hover or focus away.
function MessageTimingIndicator(props: {
  timing: NonNullable<PlaygroundMessageCost['timing']>
}) {
  const { t } = useTranslation()
  const firstToken = props.timing.first_token_ms
  const value = firstToken ?? props.timing.total_ms
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const duration = formatDuration(value, t)
  if (!duration) {
    return null
  }
  const label = firstToken === undefined ? t('Total') : t('First token')

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className='cursor-help underline decoration-dotted underline-offset-2'
              tabIndex={0}
            >
              {label}: {duration}
            </span>
          }
        />
        <TooltipContent>
          <RequestTimingBreakdown timing={props.timing} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function MessageMetadata(props: MessageMetadataProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const messageTime = formatMessageTime(props.message.createdAt)
  const duration = formatDuration(props.message.durationMs, t)
  const usage = getVersionUsage(props.version, props.cost)
  const cost = props.cost ? formatLogQuota(props.cost.quota) : undefined
  const timing = props.cost?.timing
  const details: Array<{ key: string; node: ReactNode }> = []

  if (messageTime) {
    details.push({ key: 'time', node: <time>{messageTime}</time> })
  }
  if (duration) {
    details.push({
      key: 'duration',
      node: <span>{t('Response time: {{duration}}', { duration })}</span>,
    })
  }
  if (usage) {
    details.push({
      key: 'usage',
      node: <MessageUsageIndicator locale={locale} usage={usage} />,
    })
  }
  if (cost) {
    details.push({
      key: 'cost',
      node: <span>{t('Cost: {{cost}}', { cost })}</span>,
    })
  }
  if (timing) {
    details.push({
      key: 'timing',
      node: <MessageTimingIndicator timing={timing} />,
    })
  }

  if (details.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'text-muted-foreground mt-1 flex min-h-4 flex-wrap items-center gap-1.5 text-[11px] leading-none',
        props.alignment === 'right' && 'justify-end'
      )}
    >
      {details.map((detail, index) => (
        <Fragment key={detail.key}>
          {index > 0 && <span aria-hidden='true'>·</span>}
          {detail.node}
        </Fragment>
      ))}
    </div>
  )
}
