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
import { Quote, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { PlaygroundPendingQuote } from '../../types'

interface PlaygroundQuoteBarProps {
  quote: PlaygroundPendingQuote
  onRemove: () => void
  className?: string
}

/**
 * The pending quote of the next composer turn. The bar only shows the snapshot
 * the request will carry; removing it clears the pending quote without
 * touching the quoted message.
 */
export function PlaygroundQuoteBar(props: PlaygroundQuoteBarProps) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        'border-border bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2',
        props.className
      )}
    >
      <Quote
        aria-hidden='true'
        className='text-muted-foreground mt-0.5 size-4 shrink-0'
      />
      <div className='min-w-0 flex-1'>
        <p className='text-muted-foreground text-xs'>{t('Quoted message')}</p>
        <p className='max-h-16 overflow-hidden text-sm break-words whitespace-pre-wrap'>
          {props.quote.text}
        </p>
      </div>
      <Button
        aria-label={t('Remove quote')}
        className='-mt-1 -mr-1 shrink-0'
        onClick={props.onRemove}
        size='icon-sm'
        type='button'
        variant='ghost'
      >
        <X aria-hidden='true' />
      </Button>
    </div>
  )
}
