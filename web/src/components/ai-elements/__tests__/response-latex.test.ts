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

import { preprocessLaTeX } from '../response-latex'

describe('preprocessLaTeX', () => {
  test('keeps currency dollars literal instead of opening a formula', () => {
    expect(preprocessLaTeX('costs $20 and $100 today')).toBe(
      'costs \\$20 and \\$100 today'
    )
    expect(preprocessLaTeX('cost $1,299.50 total')).toBe(
      'cost \\$1,299.50 total'
    )
    expect(preprocessLaTeX('price range $5–$10 only')).toBe(
      'price range \\$5–\\$10 only'
    )
    expect(preprocessLaTeX('cost $ 20 spaced')).toBe('cost \\$ 20 spaced')
  })

  test('leaves inline and block math delimiters untouched', () => {
    expect(preprocessLaTeX('inline $a+b$ here')).toBe('inline $a+b$ here')
    expect(preprocessLaTeX('two $x$ and $y$ formulas')).toBe(
      'two $x$ and $y$ formulas'
    )
    expect(preprocessLaTeX('subscript $x_1 + y_2$')).toBe(
      'subscript $x_1 + y_2$'
    )
    expect(preprocessLaTeX('block $$\\int_0^1 x dx$$ done')).toBe(
      'block $$\\int_0^1 x dx$$ done'
    )
  })

  test('does not double-escape an already escaped dollar', () => {
    expect(preprocessLaTeX('already \\$20 escaped')).toBe(
      'already \\$20 escaped'
    )
  })

  test('normalises the bracket delimiters the parser does not read as math', () => {
    expect(preprocessLaTeX('escaped \\[x^2\\] block')).toBe(
      'escaped $$x^2$$ block'
    )
    expect(preprocessLaTeX('paren \\(y\\) inline')).toBe('paren $y$ inline')
  })

  test('protects table column pipes inside math', () => {
    expect(preprocessLaTeX('| $a|b$ | c |')).toBe('| $a\\vert b$ | c |')
  })

  test('returns the source unchanged when no math marker is present', () => {
    const plain = 'just prose with no formulas'
    expect(preprocessLaTeX(plain)).toBe(plain)
  })
})
