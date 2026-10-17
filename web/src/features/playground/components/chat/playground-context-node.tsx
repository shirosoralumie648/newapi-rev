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
import { ChevronDownIcon, LayersIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { PlaygroundContextSummary } from '../../types'

interface PlaygroundContextNodeProps {
  summary: PlaygroundContextSummary
  disabled?: boolean
  /**
   * Undo the compression. The messages stay stored either way; removing the
   * node only makes the next request carry the full history again.
   */
  onRemove?: () => void
}

/**
 * The compression node between the messages a summary replaces and the rest of
 * the conversation. The node expands to the stored summary text and can be
 * removed, which restores sending the full history on the following requests.
 */
export function PlaygroundContextNode(props: PlaygroundContextNodeProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [open, setOpen] = useState(false)

  return (
    <div className='flex justify-center py-2'>
      <div className='border-border/60 bg-muted/30 w-full rounded-lg border px-3 py-2'>
        <Collapsible onOpenChange={setOpen} open={open}>
          <div className='flex items-center justify-between gap-2'>
            <CollapsibleTrigger
              render={
                <Button
                  className='h-7 min-w-0 px-2 text-xs'
                  size='sm'
                  type='button'
                  variant='ghost'
                />
              }
            >
              <LayersIcon aria-hidden='true' className='size-3.5 shrink-0' />
              <span className='truncate'>
                {t('Compressed {{messages}} earlier messages', {
                  messages: formatNumber(props.summary.messageCount, locale),
                })}
              </span>
              <ChevronDownIcon
                aria-hidden='true'
                className={cn(
                  'size-3.5 shrink-0 transition-transform',
                  open && 'rotate-180'
                )}
              />
            </CollapsibleTrigger>
            {props.onRemove && (
              <Button
                className='h-7 shrink-0 px-2 text-xs'
                disabled={props.disabled}
                onClick={props.onRemove}
                size='sm'
                type='button'
                variant='ghost'
              >
                {t('Remove summary')}
              </Button>
            )}
          </div>
          <CollapsibleContent className='mt-2'>
            <div
              aria-label={t('Context summary')}
              className='bg-background/60 max-h-56 overflow-y-auto rounded-md border p-2'
              role='region'
            >
              <p className='text-xs break-words whitespace-pre-wrap'>
                {props.summary.content}
              </p>
              <p className='text-muted-foreground mt-1.5 text-xs'>
                {t('Generated with {{model}}', {
                  model: props.summary.model,
                })}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}
