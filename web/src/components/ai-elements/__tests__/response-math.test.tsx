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
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { Response } from '../response'

afterEach(() => {
  cleanup()
})

describe('Response math rendering', () => {
  test('typesets inline math into KaTeX markup', () => {
    render(<Response>inline $a+b$ here</Response>)
    const katex = document.querySelector('.katex')
    expect(katex).not.toBeNull()
    expect(katex?.closest('[dir="ltr"]')).not.toBeNull()
  })

  test('typesets block math in display mode', () => {
    render(<Response>{'before\n\n$$\\int_0^1 x\\,dx$$\n\nafter'}</Response>)
    expect(document.querySelector('.katex-display')).not.toBeNull()
  })

  test('keeps currency amounts literal instead of forming a formula', () => {
    render(<Response>costs $20 and $100 today</Response>)
    expect(document.querySelector('.katex')).toBeNull()
    expect(document.body.textContent).toContain('$20')
    expect(document.body.textContent).toContain('$100')
  })

  test('escapes brackets so a display formula still typesets', () => {
    render(<Response>{'\\[x^2 + y^2\\]'}</Response>)
    expect(document.querySelector('.katex')).not.toBeNull()
  })

  test('falls back to the source text when a formula cannot be parsed', () => {
    render(<Response>{'$\\frac{1}{$'}</Response>)
    expect(document.body.textContent).toContain('\\frac')
  })
})
