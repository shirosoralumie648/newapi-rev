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

/**
 * Markdown math preprocessing.
 *
 * The bundled parser treats a `$...$` pair as inline math, so prose such as
 * "costs $20 and $100" would otherwise become a formula and lose both dollar
 * signs. This module escapes currency dollars, normalises the `\[..\]` and
 * `\(..\)` delimiters, and protects the `|` inside math so a table cell keeps
 * its column boundaries. The output must have the same length-independent
 * shape for every prefix of a streaming answer: escaping only looks at a
 * completed `$...$` pair, so a half-typed formula stays untouched until it
 * closes.
 */

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

/**
 * Escape currency dollars that would otherwise open an inline formula.
 *
 * A `$` immediately followed by a digit (optionally after spaces) is a price,
 * not a delimiter: math almost always starts with a letter, backslash, brace
 * or parenthesis. Both `$` of a price pair are escaped so the parser never
 * sees them as a formula, and an already escaped `\$` is left alone.
 */
function escapeCurrencyDollars(source: string): string {
  let result = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char !== '$' || isEscaped(source, index)) {
      result += char
      index += 1
      continue
    }
    if (source[index + 1] === '$') {
      // Block delimiter: copy the pair as a unit.
      result += '$$'
      index += 2
      continue
    }
    if (/^\s*[\d.,]/.test(source.slice(index + 1))) {
      result += '\\$'
      index += 1
      continue
    }
    result += char
    index += 1
  }
  return result
}

/** Convert `\[..\]` to `$$..$$` and `\(..\)` to `$..$`. */
function normalizeDelimiters(source: string): string {
  return source
    .replaceAll(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replaceAll(/\\\((.*?)\\\)/g, (_match, body: string) => `$${body}$`)
}

/** Escape `|` inside `$..$` and `$$..$$` so table cells keep their columns. */
function escapePipesInsideMath(source: string): string {
  return source.replaceAll(
    /\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g,
    (segment) => segment.replaceAll('|', '\\vert ')
  )
}

export function preprocessLaTeX(source: string): string {
  if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) {
    return source
  }
  let result = normalizeDelimiters(source)
  result = escapeCurrencyDollars(result)
  result = escapePipesInsideMath(result)
  return result
}
