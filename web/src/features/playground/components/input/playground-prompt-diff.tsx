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

import { CodeBlockFrame } from '@/components/ai-elements/code-block'
import { cn } from '@/lib/utils'

import type { PromptDiffLine } from '../../lib/input/prompt-diff'

interface PlaygroundPromptDiffProps {
  lines: PromptDiffLine[]
  className?: string
}

const DIFF_MARKERS: Record<PromptDiffLine['kind'], string> = {
  added: '+',
  removed: '-',
  unchanged: ' ',
}

/**
 * A compact line diff inside the shared code-block frame. Added and removed
 * lines carry a visible marker and their own background; unchanged lines keep
 * the muted code color.
 */
export function PlaygroundPromptDiff(props: PlaygroundPromptDiffProps) {
  const { t } = useTranslation()
  const changed = props.lines.some((line) => line.kind !== 'unchanged')

  return (
    <CodeBlockFrame
      bodyClassName='max-h-64 overflow-auto p-0'
      className={cn('my-0', props.className)}
    >
      <div className='text-muted-foreground flex items-center gap-3 px-3 py-1.5 font-mono text-[11px]'>
        <span className='text-emerald-600 dark:text-emerald-400'>
          + {t('Added')}
        </span>
        <span className='text-destructive'>- {t('Removed')}</span>
      </div>
      {changed ? (
        <div className='font-mono text-xs leading-5'>
          {props.lines.map((line, index) => (
            <div
              className={cn(
                'flex min-h-5 gap-2 px-3',
                line.kind === 'added' &&
                  'bg-emerald-500/10 text-emerald-950 dark:text-emerald-100',
                line.kind === 'removed' && 'bg-destructive/10 text-destructive'
              )}
              data-diff-kind={line.kind}
              key={`${line.kind}-${index}`}
            >
              <span
                aria-hidden='true'
                className='w-3 shrink-0 opacity-70 select-none'
              >
                {DIFF_MARKERS[line.kind]}
              </span>
              <span className='min-w-0 break-all whitespace-pre-wrap'>
                {line.text || ' '}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className='text-muted-foreground px-3 pb-3 text-xs'>
          {t('No changes')}
        </p>
      )}
    </CodeBlockFrame>
  )
}
