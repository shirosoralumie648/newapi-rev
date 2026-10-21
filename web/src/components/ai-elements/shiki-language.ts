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
import type { BundledLanguage } from 'shiki'

/**
 * Language aliases the markdown fences use. Shiki bundles far more grammars
 * than the previous CodeMirror setup, but a few common fence names differ from
 * Shiki's ids and a couple are not bundled at all.
 */
export const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  csharp: 'c#',
  golang: 'go',
  hlsl: 'hlsl',
  js: 'javascript',
  jsx: 'jsx',
  md: 'markdown',
  mdx: 'mdx',
  node: 'javascript',
  objc: 'objective-c',
  proto: 'proto',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
  zsh: 'bash',
}

/** Languages that always get the plaintext renderer. */
const UNSUPPORTED_LANGUAGES = new Set(['', 'text', 'plaintext', 'plain'])

const LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9+#._-]{0,31}$/i

export function normalizeShikiLanguage(
  language?: string
): BundledLanguage | 'text' {
  const normalized = language?.trim().toLowerCase() || 'text'
  if (UNSUPPORTED_LANGUAGES.has(normalized) || !LANGUAGE_PATTERN.test(normalized)) {
    return 'text'
  }
  return (SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized) as BundledLanguage
}

/**
 * Two concrete palettes rendered together with `defaultColor: false`, so
 * Shiki emits `--shiki-light`/`--shiki-dark` variables per token and the
 * project-wide `.shiki span` rules switch between them. A theme switch is
 * pure CSS; the highlighter never re-runs.
 */
export const SHIKI_LIGHT_THEME = 'github-light'
export const SHIKI_DARK_THEME = 'github-dark'
