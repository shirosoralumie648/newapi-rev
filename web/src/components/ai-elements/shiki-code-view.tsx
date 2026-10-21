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
import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

import { useShikiHighlight } from './use-shiki-highlight'

type ShikiCodeViewProps = {
  /** Accessible name of the read-only code region. */
  ariaLabel?: string
  code: string
  language?: string
  showLineNumbers?: boolean
  className?: string
}

/**
 * Read-only code view highlighted by Shiki. Shiki renders both themes at once:
 * each token carries `color` for light and `--shiki-dark` for dark, and the
 * `.dark` rule in theme.css swaps them. Until the highlighter is ready the
 * plain text renders, so a block never flashes empty. The wrapper keeps the
 * `textbox` role the previous CodeMirror view exposed, so screen readers and
 * callers that address the block by role still find it.
 */
export function ShikiCodeView(props: ShikiCodeViewProps) {
  const highlighted = useShikiHighlight(props.code, props.language)
  const lineCount = Math.max(1, props.code.split('\n').length)

  return (
    <div
      aria-label={props.ariaLabel}
      aria-readonly='true'
      className={cn('shiki-code-view min-w-0', props.className)}
      role={props.ariaLabel ? 'textbox' : undefined}
      style={
        {
          '--shiki-line-count': lineCount,
        } as CSSProperties
      }
    >
      {highlighted == null ? (
        <pre className='shiki-fallback'>
          <code>{props.code}</code>
        </pre>
      ) : (
        <div
          className={cn(
            'shiki-host',
            props.showLineNumbers && 'shiki-with-line-numbers'
          )}
          style={
            {
              '--shiki-line-count': lineCount,
            } as CSSProperties
          }
          // Shiki escapes the source text and only emits spans with inline
          // colors; there is no raw model HTML in this tree.
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      )}
    </div>
  )
}
