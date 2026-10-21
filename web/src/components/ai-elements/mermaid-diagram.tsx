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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useTheme } from '@/context/theme-provider'
import { cn } from '@/lib/utils'

import { renderMermaid, type MermaidRenderResult } from './mermaid-render'

type MermaidDiagramProps = {
  code: string
  className?: string
}

/**
 * Streaming re-render throttle. A half-typed diagram fails to parse, so the
 * last successful SVG stays on screen while the source keeps changing; once
 * the answer settles the final source replaces it.
 */
const RERENDER_INTERVAL_MS = 150

export function MermaidDiagram(props: MermaidDiagramProps) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const [result, setResult] = useState<MermaidRenderResult | null>(null)
  const [showSource, setShowSource] = useState(false)
  const lastGoodSvg = useRef<string | null>(null)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSource = useRef(props.code)
  latestSource.current = props.code

  useEffect(() => {
    let cancelled = false
    const dark = resolvedTheme === 'dark'

    const run = () => {
      void renderMermaid(latestSource.current, dark).then((next) => {
        if (cancelled) return
        if (next.status === 'ok') {
          lastGoodSvg.current = next.svg
          setResult(next)
        } else if (lastGoodSvg.current == null) {
          setResult(next)
        }
        // A failed re-render keeps the previous good SVG visible.
      })
    }

    if (pendingTimer.current != null) {
      clearTimeout(pendingTimer.current)
    }
    pendingTimer.current = setTimeout(run, RERENDER_INTERVAL_MS)

    return () => {
      cancelled = true
      if (pendingTimer.current != null) {
        clearTimeout(pendingTimer.current)
        pendingTimer.current = null
      }
    }
  }, [props.code, resolvedTheme])

  const svg =
    result?.status === 'ok' ? result.svg : (lastGoodSvg.current ?? null)
  const failed = result?.status === 'error' && lastGoodSvg.current == null

  return (
    <div
      className={cn(
        'border-border/70 bg-background my-3 overflow-hidden rounded-lg border',
        props.className
      )}
    >
      <div className='bg-muted/35 border-border/70 flex min-h-9 items-center gap-2 border-b px-2 py-1'>
        <span className='text-muted-foreground font-mono text-[11px] font-medium tracking-wide uppercase'>
          Mermaid
        </span>
        <div className='flex-1' />
        <button
          className='text-muted-foreground hover:text-foreground rounded px-2 py-0.5 text-[11px]'
          onClick={() => setShowSource((value) => !value)}
          type='button'
        >
          {showSource ? t('Preview') : t('Source')}
        </button>
      </div>
      {showSource ? (
        <pre className='overflow-x-auto p-4 font-mono text-[13px] leading-6'>
          <code>{props.code}</code>
        </pre>
      ) : failed ? (
        <div className='space-y-2 p-4'>
          <p className='text-destructive text-xs'>
            {t('The diagram could not be rendered.')}
          </p>
          <pre className='bg-muted/40 overflow-x-auto rounded p-3 font-mono text-xs'>
            <code>{props.code}</code>
          </pre>
        </div>
      ) : svg == null ? (
        <pre className='text-muted-foreground overflow-x-auto p-4 font-mono text-xs'>
          <code>{props.code}</code>
        </pre>
      ) : (
        <div
          className='mermaid-host flex justify-center overflow-x-auto p-4 [&_svg]:h-auto [&_svg]:max-w-full'
          // Mermaid output is sanitized by DOMPurify in mermaid-render.ts.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
