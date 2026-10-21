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
import DOMPurify from 'dompurify'

/**
 * Mermaid is a ~2 MB dependency and only chats that contain a ```mermaid
 * fence should download it, so it is imported on demand.
 */
type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let mermaidPromise: Promise<MermaidApi> | null = null
let renderSequence = 0

function getMermaid(dark: boolean): Promise<MermaidApi> {
  if (mermaidPromise == null) {
    mermaidPromise = import('mermaid').then((module) => {
      const api = (module.default ?? module) as unknown as MermaidApi
      return api
    })
  }
  return mermaidPromise.then((api) => {
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // A theme switch re-renders through this flag; the diagram itself is
      // regenerated from source so no stale colors survive.
      theme: dark ? 'dark' : 'default',
      fontFamily: 'var(--font-sans)',
      flowchart: { htmlLabels: false },
    })
    return api
  })
}

/**
 * Sanitize Mermaid's SVG output. Mermaid runs with securityLevel 'strict',
 * but its output is still injected as markup, so the SVG is run through
 * DOMPurify with the SVG profile to drop scripts, event handlers and
 * external references before it reaches the DOM.
 *
 * Mermaid puts its geometry and color rules in an inline `<svg><style>` block.
 * Removing it leaves every node with no fill/stroke (black shapes, invisible
 * labels), so style elements are kept — DOMPurify still runs the CSS through
 * its sanitizer, and `securityLevel: 'strict'` never emits script-bearing CSS.
 */
function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject', 'style'],
    FORBID_TAGS: ['script'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  })
}

export type MermaidRenderResult =
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string }

export async function renderMermaid(
  source: string,
  dark: boolean
): Promise<MermaidRenderResult> {
  const text = source.trim()
  if (text === '') {
    return { status: 'error', message: 'Empty diagram' }
  }
  try {
    const api = await getMermaid(dark)
    renderSequence += 1
    const id = `mermaid-${renderSequence}`
    const { svg } = await api.render(id, text)
    return { status: 'ok', svg: sanitizeSvg(svg) }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
