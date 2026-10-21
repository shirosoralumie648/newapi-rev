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

import { getNodeKey } from '../response-content'
import { Response } from '../response'

afterEach(() => {
  cleanup()
})

const fill = (text: string, times: number) => `${text}\n\n`.repeat(times)

describe('Response long content', () => {
  test('keeps headings and tables past the old 20k cap', () => {
    const body = [
      '## Report',
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
      fill('filler paragraph text that pads the answer out', 900),
      '## Final section',
    ].join('\n\n')
    expect(body.length).toBeGreaterThan(20_000)

    render(<Response>{body}</Response>)

    expect(document.querySelectorAll('h2').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector('table')).not.toBeNull()
  })

  test('a code block keeps its formatting in a long answer', () => {
    const body = `${fill('padding text for the long answer', 700)}
\`\`\`python
print("kept")
\`\`\``
    expect(body.length).toBeGreaterThan(20_000)

    render(<Response>{body}</Response>)

    const text = document.body.textContent ?? ''
    expect(text).toContain('print("kept")')
    expect(document.querySelector('pre, .shiki-code-view')).not.toBeNull()
  })
})

describe('getNodeKey', () => {
  test('does not change when the node text grows', () => {
    const first = { type: 'code_block', raw: 'a' } as never
    const grown = { type: 'code_block', raw: 'abcdefghijklmnopqrstuvwxyz' } as never
    expect(getNodeKey(first, 3)).toBe(getNodeKey(grown, 3))
  })

  test('distinguishes position and type', () => {
    const node = { type: 'paragraph', raw: 'same' } as never
    expect(getNodeKey(node, 0)).not.toBe(getNodeKey(node, 1))
  })
})
