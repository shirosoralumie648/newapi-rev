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

export type PromptDiffLineKind = 'added' | 'removed' | 'unchanged'

/** One rendered line of a line-by-line text diff. */
export interface PromptDiffLine {
  kind: PromptDiffLineKind
  text: string
}

// Above this many line pairs the quadratic LCS table is replaced by a coarse
// prefix/suffix diff, so a huge pasted template cannot freeze the dialog.
const MAX_LCS_CELLS = 250_000

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

function coarseDiff(previous: string[], next: string[]): PromptDiffLine[] {
  let prefix = 0
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const lines: PromptDiffLine[] = []
  for (let index = 0; index < prefix; index += 1) {
    lines.push({ kind: 'unchanged', text: previous[index] })
  }
  for (let index = prefix; index < previous.length - suffix; index += 1) {
    lines.push({ kind: 'removed', text: previous[index] })
  }
  for (let index = prefix; index < next.length - suffix; index += 1) {
    lines.push({ kind: 'added', text: next[index] })
  }
  for (
    let index = previous.length - suffix;
    index < previous.length;
    index += 1
  ) {
    lines.push({ kind: 'unchanged', text: previous[index] })
  }
  return lines
}

/**
 * Compare two template revisions line by line. Unchanged lines stay in place,
 * removed lines keep their original order, and added lines follow the removed
 * block of the same hunk. The comparison normalizes CRLF so a line ending
 * change alone does not mark the whole template as rewritten.
 */
export function diffPromptTemplateLines(
  previousText: string,
  nextText: string
): PromptDiffLine[] {
  const previous = splitLines(previousText)
  const next = splitLines(nextText)
  if (previousText === nextText || previous.join('\n') === next.join('\n')) {
    return previous.map((text) => ({ kind: 'unchanged', text }))
  }
  if (previous.length * next.length > MAX_LCS_CELLS) {
    return coarseDiff(previous, next)
  }

  const columns = next.length + 1
  const table = new Uint32Array((previous.length + 1) * columns)
  for (let row = previous.length - 1; row >= 0; row -= 1) {
    for (let column = next.length - 1; column >= 0; column -= 1) {
      const offset = row * columns + column
      if (previous[row] === next[column]) {
        table[offset] = table[(row + 1) * columns + column + 1] + 1
        continue
      }
      table[offset] = Math.max(
        table[(row + 1) * columns + column],
        table[row * columns + column + 1]
      )
    }
  }

  const lines: PromptDiffLine[] = []
  let row = 0
  let column = 0
  while (row < previous.length && column < next.length) {
    if (previous[row] === next[column]) {
      lines.push({ kind: 'unchanged', text: previous[row] })
      row += 1
      column += 1
      continue
    }
    if (
      table[(row + 1) * columns + column] >= table[row * columns + column + 1]
    ) {
      lines.push({ kind: 'removed', text: previous[row] })
      row += 1
      continue
    }
    lines.push({ kind: 'added', text: next[column] })
    column += 1
  }
  while (row < previous.length) {
    lines.push({ kind: 'removed', text: previous[row] })
    row += 1
  }
  while (column < next.length) {
    lines.push({ kind: 'added', text: next[column] })
    column += 1
  }
  return lines
}
