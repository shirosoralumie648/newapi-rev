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
import { useEffect, useMemo, useState } from 'react'
import type { BundledLanguage, Highlighter } from 'shiki'

import {
  normalizeShikiLanguage,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from './shiki-language'

/**
 * One highlighter is reused for every code block on the page. Creating a
 * highlighter takes tens of milliseconds and loading a grammar is a network
 * round trip, so it is created lazily on the first block that needs it and
 * kept for the lifetime of the tab.
 */
let highlighterPromise: Promise<Highlighter> | null = null
const loadedLanguages = new Set<string>()

function getHighlighter(language: BundledLanguage | 'text'): Promise<Highlighter> {
  if (highlighterPromise == null) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: [SHIKI_LIGHT_THEME, SHIKI_DARK_THEME],
        langs: [],
      })
    )
  }
  return highlighterPromise.then(async (highlighter) => {
    if (language !== 'text' && !loadedLanguages.has(language)) {
      try {
        await highlighter.loadLanguage(language)
        loadedLanguages.add(language)
      } catch {
        // A grammar that Shiki does not bundle falls back to plaintext; the
        // block still renders, it just carries no token colors.
      }
    }
    return highlighter
  })
}

export type HighlightedCode = {
  html: string
  language: BundledLanguage | 'text'
}

/**
 * Highlight a fenced block. Returns null until the highlighter is ready; the
 * caller renders the plain text in the meantime so the block never flashes a
 * loading spinner.
 */
export function useShikiHighlight(
  code: string,
  language?: string
): HighlightedCode | null {
  const target = useMemo(() => normalizeShikiLanguage(language), [language])
  const [result, setResult] = useState<HighlightedCode | null>(null)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    void getHighlighter(target)
      .then((highlighter) => {
        if (cancelled) return
        if (target === 'text') {
          setResult({
            html: escapeHtml(code),
            language: 'text',
          })
          return
        }
        try {
          setResult({
            html: highlighter.codeToHtml(code, {
              lang: target,
              themes: {
                light: SHIKI_LIGHT_THEME,
                dark: SHIKI_DARK_THEME,
              },
              // Emit `--shiki-light`/`--shiki-dark` variables instead of a
              // resolved color; the project stylesheet picks the active one.
              defaultColor: false,
            }),
            language: target,
          })
        } catch {
          if (!cancelled) {
            setResult({ html: escapeHtml(code), language: 'text' })
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ html: escapeHtml(code), language: 'text' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [code, target])

  return result
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
