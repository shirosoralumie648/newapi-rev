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
import { Film } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import {
  canvasVideoWorkbenchVariantLabel,
  type CanvasVideoWorkbenchVariant,
} from '../../lib/canvas-video-workbench'

interface CanvasVideoWorkbenchVariantsProps {
  variants: CanvasVideoWorkbenchVariant[]
  /** Variant the main player currently plays. */
  activeNodeId: string | null
  disabled?: boolean
  onPrefer: (nodeId: string) => void
}

/**
 * The version strip of one video bloodline. Each tile names the result and the
 * concrete seed of its retry record; clicking one marks it preferred, which is
 * the same choice downstream steps and the board read.
 */
export function CanvasVideoWorkbenchVariants(
  props: CanvasVideoWorkbenchVariantsProps
) {
  const { t } = useTranslation()
  if (props.variants.length === 0) return null

  return (
    <section
      aria-label={t('Versions')}
      className='flex shrink-0 flex-col gap-1 border-t px-3 py-2'
    >
      <span className='text-muted-foreground text-xs'>{t('Versions')}</span>
      <div className='flex gap-2 overflow-x-auto pb-1'>
        {props.variants.map((variant, index) => {
          const active = variant.node.id === props.activeNodeId
          const label = canvasVideoWorkbenchVariantLabel(
            variant,
            variant.node.data.label?.trim() ||
              t('Version {{index}}', { index: index + 1 })
          )
          return (
            <button
              aria-label={label}
              aria-pressed={active}
              className={cn(
                'bg-muted/20 flex w-24 shrink-0 flex-col gap-1 rounded-md border p-1 text-start',
                active && 'border-ring ring-ring ring-1'
              )}
              disabled={props.disabled}
              key={variant.node.id}
              onClick={() => props.onPrefer(variant.node.id)}
              type='button'
            >
              <span className='bg-muted/40 flex h-16 items-center justify-center rounded-sm'>
                <Film aria-hidden='true' className='size-6' />
              </span>
              <span className='text-muted-foreground truncate text-[11px]'>
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
