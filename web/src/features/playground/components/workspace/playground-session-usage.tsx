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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { toIntlLocale } from '@/i18n/languages'
import { formatLogQuota, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import { sumConversationUsage } from '../../lib'
import type { Message, PlaygroundMessageCost } from '../../types'

interface PlaygroundSessionUsageProps {
  className?: string
  messages: Message[]
  /** Settled cost rows of the conversation's relay requests, by request id. */
  costs?: ReadonlyMap<string, PlaygroundMessageCost>
}

/**
 * Totals of the conversation's active versions: the tokens the relay reported
 * and the settled cost of every request whose consume row is loaded. Nothing is
 * shown for a conversation that has no generation record yet.
 */
export function PlaygroundSessionUsage(props: PlaygroundSessionUsageProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const summary = useMemo(
    () => sumConversationUsage(props.messages, props.costs),
    [props.messages, props.costs]
  )

  if (!summary.hasUsage && !summary.hasCost) {
    return null
  }

  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-1.5 px-4 py-1 text-xs',
        props.className
      )}
    >
      <span className='font-medium'>{t('Session usage')}</span>
      {summary.hasUsage && (
        <span>
          {t('Tokens: {{tokens}}', {
            tokens: formatNumber(summary.usage.totalTokens, locale),
          })}
        </span>
      )}
      {summary.hasCost && (
        <span>
          {t('Cost: {{cost}}', { cost: formatLogQuota(summary.quota) })}
        </span>
      )}
    </div>
  )
}
