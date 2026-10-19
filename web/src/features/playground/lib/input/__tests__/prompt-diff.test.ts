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
import { expect, test } from 'vitest'

import { diffPromptTemplateLines } from '../prompt-diff'

test('a changed line is reported as one removal followed by one addition', () => {
  expect(
    diffPromptTemplateLines(
      ['Keep this.', 'Remove this.', 'Keep the tail.'].join('\n'),
      ['Keep this.', 'Add this.', 'Keep the tail.'].join('\n')
    )
  ).toEqual([
    { kind: 'unchanged', text: 'Keep this.' },
    { kind: 'removed', text: 'Remove this.' },
    { kind: 'added', text: 'Add this.' },
    { kind: 'unchanged', text: 'Keep the tail.' },
  ])
})

test('identical templates report every line as unchanged', () => {
  expect(diffPromptTemplateLines('one\ntwo\n', 'one\ntwo\n')).toEqual([
    { kind: 'unchanged', text: 'one' },
    { kind: 'unchanged', text: 'two' },
    { kind: 'unchanged', text: '' },
  ])
})

test('CRLF normalization does not mark an otherwise identical template as rewritten', () => {
  expect(diffPromptTemplateLines('one\r\ntwo\r\n', 'one\ntwo\n')).toEqual([
    { kind: 'unchanged', text: 'one' },
    { kind: 'unchanged', text: 'two' },
    { kind: 'unchanged', text: '' },
  ])
})

test('insertions keep the surrounding unchanged lines in place', () => {
  expect(
    diffPromptTemplateLines(
      'alpha\nbeta',
      'alpha\ninserted one\ninserted two\nbeta'
    )
  ).toEqual([
    { kind: 'unchanged', text: 'alpha' },
    { kind: 'added', text: 'inserted one' },
    { kind: 'added', text: 'inserted two' },
    { kind: 'unchanged', text: 'beta' },
  ])
})

test('a large template falls back to a bounded prefix and suffix diff', () => {
  const previous = Array.from({ length: 600 }, (_, index) => `old ${index}`)
  const next = [...previous]
  next[300] = 'new 300'
  const diff = diffPromptTemplateLines(previous.join('\n'), next.join('\n'))

  expect(diff[0]).toEqual({ kind: 'unchanged', text: 'old 0' })
  expect(diff).toContainEqual({ kind: 'removed', text: 'old 300' })
  expect(diff).toContainEqual({ kind: 'added', text: 'new 300' })
  expect(diff[diff.length - 1]).toEqual({
    kind: 'unchanged',
    text: 'old 599',
  })
})
