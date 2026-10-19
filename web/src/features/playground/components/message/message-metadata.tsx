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
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toIntlLocale } from '@/i18n/languages'
import { formatLogQuota, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import {
  formatMessageDuration,
  getMessageCacheUsage,
  getVersionUsage,
} from '../../lib'
import type { MessageAlignment } from '../../lib'
import type {
  Message,
  MessageUsage,
  MessageVersion,
  PlaygroundMessageCost,
} from '../../types'
import { RequestDiagnosticsPopover } from './request-diagnostics'

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

export function MessageMetadata(props: MessageMetadataProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const messageTime = formatMessageTime(props.message.createdAt)
  const duration = formatMessageDuration(props.message.durationMs, t)
  const usage = getVersionUsage(props.version, props.cost)
  const cost = props.cost ? formatLogQuota(props.cost.quota) : undefined
  const cache = getMessageCacheUsage(props.cost)
  const groupRatio = props.cost?.groupRatio
  const hasGroupRatio =
    typeof groupRatio === 'number' &&
    Number.isFinite(groupRatio) &&
    groupRatio !== 1
  const hasDiagnostics = Boolean(
    props.cost?.timing || props.cost?.channelKey || cache || hasGroupRatio
  )
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
  if (props.cost && hasDiagnostics) {
    details.push({
      key: 'diagnostics',
      node: (
        <RequestDiagnosticsPopover
          alignment={props.alignment}
          cost={props.cost}
          locale={locale}
        />
      ),
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
