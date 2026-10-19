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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeBlock } from '@/components/ai-elements/code-block'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { formatLogQuota } from '@/lib/format'

import { usePlaygroundMessageCosts } from '../../hooks'
import type { NonChatTextIssue } from '../../lib/tools/nonchat'

/** Shared local-limit copy for the three non-chat panels. */
export function nonChatIssueMessage(
  t: (key: string, options?: Record<string, unknown>) => string,
  issue: NonChatTextIssue,
  limits: { count: number; length: number }
): string {
  if (issue === 'empty') {
    return t('Enter at least one input.')
  }
  if (issue === 'too_many') {
    return t('Split the text into no more than {{count}} inputs.', {
      count: limits.count,
    })
  }
  return t('Each input must be at most {{length}} characters.', {
    length: limits.length,
  })
}

/**
 * Settled quota of one relay response. The hook is read-only and stops polling
 * when the runtime has consume logs disabled.
 */
export function NonChatResultMeta(props: {
  requestId?: string
  userId: number | null
}) {
  const { t } = useTranslation()
  const requestIds = props.requestId ? [props.requestId] : []
  const costsQuery = usePlaygroundMessageCosts(props.userId, requestIds)
  if (!props.requestId) return null
  const cost = costsQuery.data?.costs.get(props.requestId)

  return (
    <div className='text-muted-foreground flex flex-wrap items-center gap-2 text-xs'>
      <span className='font-mono'>{props.requestId}</span>
      {cost ? (
        <span>
          {t('Settled quota')}: {formatLogQuota(cost.quota)}
        </span>
      ) : null}
      {costsQuery.data && !costsQuery.data.enabled ? (
        <span>
          {t(
            'Settled cost details are unavailable because consumption logs are turned off.'
          )}
        </span>
      ) : null}
      {!costsQuery.data ? (
        <span>{t('Looking up the settled cost...')}</span>
      ) : null}
    </div>
  )
}

/** Collapsible raw response with a copy-ready JSON body. */
export function NonChatResultJson(props: { raw: unknown }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const json = JSON.stringify(props.raw, null, 2)

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        render={<Button size='sm' type='button' variant='outline' />}
      >
        {t('Result JSON')}
      </CollapsibleTrigger>
      <CollapsibleContent className='mt-2'>
        <CodeBlock
          code={json}
          language='json'
          maxExpandedLines={24}
          showToolbar
          title={t('Result JSON')}
        >
          <CopyButton
            aria-label={t('Copy JSON')}
            tooltip={t('Copy JSON')}
            value={json}
          />
        </CodeBlock>
      </CollapsibleContent>
    </Collapsible>
  )
}
