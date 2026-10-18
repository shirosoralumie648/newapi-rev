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
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { PlaygroundContextPlan } from '../../lib'
import type { PlaygroundContextSettings } from '../../types'

interface PlaygroundContextStatusProps {
  plan: PlaygroundContextPlan
  settings: PlaygroundContextSettings
  isSummarizing?: boolean
  className?: string
}

/**
 * The context scale of the next send, shown above the composer so a limit is
 * never applied silently: how many messages and approximately how many tokens
 * the model receives, and what happens to the messages a limit leaves out.
 */
export function PlaygroundContextStatus(props: PlaygroundContextStatusProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const sentMessageCount =
    props.plan.includedMessages.length + (props.plan.summaryUsed ? 1 : 0)

  if (sentMessageCount === 0 && !props.isSummarizing) {
    return null
  }

  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs',
        props.className
      )}
    >
      <span>
        {t(
          'Context to send: {{messages}} messages · ~{{tokens}} tokens (estimated)',
          {
            messages: formatNumber(sentMessageCount, locale),
            tokens: formatNumber(props.plan.estimatedTokens, locale),
          }
        )}
      </span>
      {props.plan.droppedMessages.length > 0 &&
        (props.settings.autoSummarize ? (
          <span className='text-amber-600 dark:text-amber-400' role='status'>
            {t(
              'The next send summarizes {{messages}} older messages (~{{tokens}} tokens).',
              {
                messages: formatNumber(
                  props.plan.droppedMessages.length,
                  locale
                ),
                tokens: formatNumber(props.plan.droppedTokens, locale),
              }
            )}
          </span>
        ) : (
          <span className='text-amber-600 dark:text-amber-400' role='status'>
            {t(
              '{{messages}} older messages are left out of the next request (~{{tokens}} tokens).',
              {
                messages: formatNumber(
                  props.plan.droppedMessages.length,
                  locale
                ),
                tokens: formatNumber(props.plan.droppedTokens, locale),
              }
            )}
          </span>
        ))}
      {props.plan.omittedImages > 0 && (
        <span className='text-amber-600 dark:text-amber-400' role='status'>
          {t(
            '{{images}} images from earlier messages are left out of the next request.',
            {
              images: formatNumber(props.plan.omittedImages, locale),
            }
          )}
        </span>
      )}
      {props.isSummarizing && (
        <span role='status'>{t('Summarizing conversation...')}</span>
      )}
    </div>
  )
}
