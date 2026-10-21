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

import { splitMarkdownChunks } from '../response-chunk'

describe('splitMarkdownChunks', () => {
  test('keeps a short answer in one chunk', () => {
    expect(splitMarkdownChunks('hello\n\nworld', 100)).toEqual([
      'hello\n\nworld',
    ])
  })

  test('splits on blank lines once the limit is reached', () => {
    const source = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(60)}`
    const chunks = splitMarkdownChunks(source, 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toContain('a'.repeat(60))
    expect(chunks.join('')).toContain('c'.repeat(60))
  })

  test('never cuts inside a fenced code block', () => {
    const fence = `\`\`\`python\n${'x = 1\n'.repeat(40)}\`\`\``
    const source = `${'a'.repeat(80)}\n\n${fence}\n\n${'b'.repeat(80)}`
    const chunks = splitMarkdownChunks(source, 60)
    const containingFence = chunks.filter((chunk) => chunk.includes('```'))
    expect(containingFence).toHaveLength(1)
    expect(containingFence[0]).toContain('```python')
    expect(containingFence[0].trimEnd().endsWith('```')).toBe(true)
  })

  test('keeps an unterminated fence with the remaining text', () => {
    const source = `intro\n\n\`\`\`python\n${'x = 1\n'.repeat(50)}`
    const chunks = splitMarkdownChunks(source, 40)
    const joined = chunks.join('')
    expect(joined).toContain('```python')
    expect(joined).toContain('x = 1')
  })

  test('handles tilde fences', () => {
    const fence = `~~~js\n${'const a = 1\n'.repeat(30)}~~~`
    const source = `${'a'.repeat(50)}\n\n${fence}\n\n${'b'.repeat(50)}`
    const chunks = splitMarkdownChunks(source, 40)
    const containingFence = chunks.filter((chunk) => chunk.includes('~~~'))
    expect(containingFence).toHaveLength(1)
  })

  test('always returns at least one chunk', () => {
    expect(splitMarkdownChunks('', 10)).toEqual([''])
  })
})
