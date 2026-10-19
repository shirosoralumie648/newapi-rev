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

import {
  KNOWLEDGE_CHUNK_MAX_BYTES,
  KNOWLEDGE_CHUNK_MAX_COUNT,
  KnowledgeChunkError,
  chunkKnowledgeText,
} from '../chunker'

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

describe('chunkKnowledgeText', () => {
  test('empty or whitespace-only text produces no chunks', () => {
    expect(chunkKnowledgeText('')).toEqual([])
    expect(chunkKnowledgeText(' \n\t ')).toEqual([])
  })

  test('short Unicode text stays one exact chunk without splitting code points', () => {
    const text = '知识库 chunking 🚀 tested.'
    const chunks = chunkKnowledgeText(text)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ index: 0, text })
    expect(chunks[0].text).not.toContain('\uFFFD')
  })

  test('long text is deterministic, capped and indexed contiguously', () => {
    const text = 'a'.repeat(3000)
    const first = chunkKnowledgeText(text)
    const second = chunkKnowledgeText(text)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(1)
    expect(first.map((chunk) => chunk.index)).toEqual(
      first.map((_, index) => index)
    )
    for (const chunk of first) {
      expect(byteLength(chunk.text)).toBeLessThanOrEqual(
        KNOWLEDGE_CHUNK_MAX_BYTES
      )
    }
    // The 128-byte overlap makes the start of the next chunk repeat the end of
    // the previous one for text without natural boundaries.
    expect(first[0].text.slice(-64)).toBe(first[1].text.slice(0, 64))
  })

  test('a nearby newline wins over an arbitrary target boundary', () => {
    const prefix = 'a'.repeat(900)
    const chunks = chunkKnowledgeText(`${prefix}\n${'b'.repeat(300)}`)

    expect(chunks[0].text).toBe(prefix)
    expect(chunks).toHaveLength(2)
  })

  test('text that would exceed the document chunk cap is rejected', () => {
    const text = 'a'.repeat(600 * 1024)
    expect(() => chunkKnowledgeText(text)).toThrow(KnowledgeChunkError)
    try {
      chunkKnowledgeText(text)
    } catch (error) {
      expect((error as KnowledgeChunkError).code).toBe('too_many_chunks')
    }
    expect(KNOWLEDGE_CHUNK_MAX_COUNT).toBe(500)
  })
})
