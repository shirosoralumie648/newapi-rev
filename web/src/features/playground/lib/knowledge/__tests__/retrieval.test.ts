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

import type {
  KnowledgeStaleDocument,
  MessageKnowledgeResult,
} from '../../../types'
import {
  KNOWLEDGE_RETRIEVAL_CHAR_BUDGET,
  KNOWLEDGE_RETRIEVAL_MAX_RESULTS,
  mergeKnowledgeSearchResults,
} from '../retrieval'

function hit(
  overrides: Partial<MessageKnowledgeResult> = {}
): MessageKnowledgeResult {
  return {
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'Handbook',
    documentId: 'doc-1',
    filename: 'handbook.txt',
    chunkId: 'chunk-1',
    chunkIndex: 0,
    score: 0.5,
    text: 'source text',
    ...overrides,
  }
}

function stale(
  overrides: Partial<KnowledgeStaleDocument> = {}
): KnowledgeStaleDocument {
  return {
    id: 'doc-stale',
    filename: 'stale.txt',
    embeddingModel: 'embed-old',
    ...overrides,
  }
}

describe('mergeKnowledgeSearchResults', () => {
  test('orders merged hits deterministically and keeps the first duplicate', () => {
    const merged = mergeKnowledgeSearchResults([
      {
        hits: [
          hit({
            chunkId: 'guide',
            filename: 'guide.txt',
            chunkIndex: 2,
            score: 0.9,
            text: 'guide',
          }),
          hit({
            chunkId: 'notes',
            filename: 'notes.txt',
            chunkIndex: 1,
            score: 0.4,
            text: 'first copy',
          }),
        ],
        staleDocuments: [],
      },
      {
        hits: [
          hit({
            chunkId: 'archive',
            filename: 'archive.txt',
            chunkIndex: 1,
            score: 0.9,
            text: 'archive',
          }),
          hit({
            chunkId: 'notes',
            filename: 'notes.txt',
            chunkIndex: 1,
            score: 0.8,
            text: 'duplicate copy',
          }),
        ],
        staleDocuments: [],
      },
    ])

    expect(merged.hits.map((result) => result.chunkId)).toEqual([
      'archive',
      'guide',
      'notes',
    ])
    expect(merged.hits[2].text).toBe('first copy')
  })

  test('deduplicates stale documents and reports them by filename', () => {
    const merged = mergeKnowledgeSearchResults([
      {
        hits: [],
        staleDocuments: [
          stale({ id: 'doc-z', filename: 'z.txt' }),
          stale({ id: 'doc-a', filename: 'a.txt' }),
        ],
      },
      {
        hits: [],
        staleDocuments: [
          stale({ id: 'doc-z', filename: 'z.txt' }),
          stale({ id: 'doc-m', filename: 'm.txt' }),
        ],
      },
    ])

    expect(merged.staleDocuments).toEqual([
      stale({ id: 'doc-a', filename: 'a.txt' }),
      stale({ id: 'doc-m', filename: 'm.txt' }),
      stale({ id: 'doc-z', filename: 'z.txt' }),
    ])
  })

  test('caps the merged list at the server result bound', () => {
    const merged = mergeKnowledgeSearchResults([
      {
        hits: Array.from(
          { length: KNOWLEDGE_RETRIEVAL_MAX_RESULTS + 1 },
          (_, index) =>
            hit({
              chunkId: `chunk-${index}`,
              filename: `file-${index}.txt`,
              score: 1 - index / 100,
            })
        ),
        staleDocuments: [],
      },
    ])

    expect(merged.hits).toHaveLength(KNOWLEDGE_RETRIEVAL_MAX_RESULTS)
    expect(merged.hits[0].chunkId).toBe('chunk-0')
    expect(merged.hits.at(-1)?.chunkId).toBe(
      `chunk-${KNOWLEDGE_RETRIEVAL_MAX_RESULTS - 1}`
    )
  })

  test('trims the last hit to the shared character budget and drops the rest', () => {
    const merged = mergeKnowledgeSearchResults([
      {
        hits: [
          hit({
            chunkId: 'near-limit',
            filename: 'a.txt',
            score: 0.9,
            text: 'a'.repeat(KNOWLEDGE_RETRIEVAL_CHAR_BUDGET - 1),
          }),
          hit({
            chunkId: 'tail',
            filename: 'b.txt',
            score: 0.8,
            text: '知识库',
          }),
          hit({
            chunkId: 'dropped',
            filename: 'c.txt',
            score: 0.7,
            text: 'never sent',
          }),
        ],
        staleDocuments: [],
      },
    ])

    expect(merged.hits).toHaveLength(2)
    expect(merged.hits[0].truncated).toBeUndefined()
    expect(merged.hits[1]).toMatchObject({
      chunkId: 'tail',
      text: '知',
      truncated: true,
    })
  })
})
