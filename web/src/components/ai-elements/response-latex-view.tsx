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

import {
  ensureKatexStylesheet,
  renderLatexHtml,
} from './response-latex-render'

/**
 * KaTeX markup is produced by KaTeX from the formula source, so the HTML is
 * trusted; `trust: false` inside the renderer blocks link-like commands. The
 * stylesheet is loaded on first use because it is far larger than the rest of
 * this module.
 */
function KatexSpan(props: { source: string; displayMode: boolean }) {
  const html = useMemo(
    () => renderLatexHtml(props.source, props.displayMode),
    [props.displayMode, props.source]
  )
  useMemo(() => void ensureKatexStylesheet(), [])
  if (html == null) {
    return (
      <code className='bg-muted/70 text-foreground rounded px-1 py-0.5 font-mono text-[0.9em]'>
        {props.source}
      </code>
    )
  }
  return (
    <span dangerouslySetInnerHTML={{ __html: html }} dir='ltr' />
  )
}

export function KatexBlock(props: { source: string }) {
  return <KatexSpan displayMode source={props.source} />
}

export function KatexInline(props: { source: string }) {
  return <KatexSpan displayMode={false} source={props.source} />
}
