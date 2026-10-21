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
import { describe, expect, test } from 'vitest'

import { normalizeShikiLanguage } from '../shiki-language'

describe('normalizeShikiLanguage', () => {
  test('maps the fence aliases the markdown uses', () => {
    expect(normalizeShikiLanguage('py')).toBe('python')
    expect(normalizeShikiLanguage('golang')).toBe('go')
    expect(normalizeShikiLanguage('sh')).toBe('bash')
    expect(normalizeShikiLanguage('csharp')).toBe('c#')
    expect(normalizeShikiLanguage('yml')).toBe('yaml')
    expect(normalizeShikiLanguage('ts')).toBe('typescript')
    expect(normalizeShikiLanguage('md')).toBe('markdown')
  })

  test('passes through a bundled language id', () => {
    expect(normalizeShikiLanguage('python')).toBe('python')
    expect(normalizeShikiLanguage('rust')).toBe('rust')
    expect(normalizeShikiLanguage('sql')).toBe('sql')
  })

  test('falls back to plaintext for empty or placeholder fences', () => {
    expect(normalizeShikiLanguage(undefined)).toBe('text')
    expect(normalizeShikiLanguage('')).toBe('text')
    expect(normalizeShikiLanguage('plaintext')).toBe('text')
    expect(normalizeShikiLanguage('text')).toBe('text')
  })

  test('rejects a fence label that cannot be a language id', () => {
    expect(normalizeShikiLanguage('not a language!')).toBe('text')
    expect(normalizeShikiLanguage('x'.repeat(64))).toBe('text')
  })
})
