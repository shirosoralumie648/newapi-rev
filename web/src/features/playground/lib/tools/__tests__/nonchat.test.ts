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
  cosineSimilarity,
  formatNonChatScore,
  moderationCategoryRows,
  pairwiseCosineSimilarities,
  parseNonChatLines,
  sortRerankItems,
} from '../nonchat'
import {
  buildNonChatRequestBody,
  buildNonChatRequestCode,
} from '../nonchat-request-code'

describe('parseNonChatLines', () => {
  test('trims lines, keeps content order and drops blank lines', () => {
    expect(parseNonChatLines(' first \n\nsecond\r\n third ', 4, 20)).toEqual({
      values: ['first', 'second', 'third'],
    })
  })

  test('reports an empty value', () => {
    expect(parseNonChatLines('  \n ', 4, 20)).toEqual({
      values: [],
      issue: 'empty',
    })
  })

  test('reports too many items before checking item length', () => {
    expect(parseNonChatLines('a\nb\nc', 2, 20)).toMatchObject({
      issue: 'too_many',
    })
  })

  test('reports an item over the character limit', () => {
    expect(parseNonChatLines('ok\n123456', 4, 5)).toMatchObject({
      issue: 'too_long',
    })
  })
})

describe('cosineSimilarity', () => {
  test('computes identical and orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  test('returns null for mismatched dimensions and zero for a zero vector', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBeNull()
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
  })

  test('returns every upper-triangle pair and truncates large responses', () => {
    const pairs = pairwiseCosineSimilarities(
      [
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      2
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ left: 0, right: 1, value: 0 })
  })
})

describe('sortRerankItems', () => {
  test('orders by score descending and breaks ties by original index', () => {
    expect(
      sortRerankItems([
        { index: 2, score: 0.2 },
        { index: 1, score: 0.9 },
        { index: 0, score: 0.2 },
      ]).map((item) => item.index)
    ).toEqual([1, 0, 2])
  })
})

describe('moderationCategoryRows', () => {
  test('sorts categories and marks only scores at or above the threshold', () => {
    const rows = moderationCategoryRows(
      {
        flagged: true,
        categories: { hate: true, violence: false },
        categoryScores: { hate: 0.8, violence: 0.4 },
      },
      0.5
    )
    expect(rows).toEqual([
      { name: 'hate', score: 0.8, flagged: true, highlighted: true },
      { name: 'violence', score: 0.4, flagged: false, highlighted: false },
    ])
  })

  test('keeps the provider flag independent from the local threshold', () => {
    const rows = moderationCategoryRows(
      {
        flagged: false,
        categories: { hate: false },
        categoryScores: { hate: 0.9 },
      },
      0.5
    )
    expect(rows[0]).toMatchObject({ highlighted: true, flagged: false })
  })
})

describe('formatNonChatScore', () => {
  test('uses the requested Intl locale and keeps up to four decimals', () => {
    expect(formatNonChatScore(0.123456, 'zh-CN')).toBe('0.1235')
    expect(formatNonChatScore(null)).toBe('-')
  })
})

describe('non-chat request exports', () => {
  const body = {
    model: 'rerank-model',
    group: 'vip',
    query: 'hello',
    documents: ['a', 'b'],
  }

  test('drops the Playground-only group field from the public body', () => {
    expect(buildNonChatRequestBody(body)).toEqual({
      model: 'rerank-model',
      query: 'hello',
      documents: ['a', 'b'],
    })
  })

  test('builds cURL, Python, Node and JSON tabs with a placeholder key', () => {
    const curl = buildNonChatRequestCode(
      'curl',
      '/v1/rerank',
      body,
      'https://api.example.com/'
    )
    expect(curl).toContain("curl 'https://api.example.com/v1/rerank'")
    expect(curl).toContain('$NEWAPI_API_KEY')
    expect(curl).toContain('"model": "rerank-model"')
    expect(curl).not.toContain('"group":')

    const python = buildNonChatRequestCode(
      'python',
      '/v1/rerank',
      body,
      'https://api.example.com'
    )
    expect(python).toContain('urllib.request.Request')
    expect(python).toContain('https://api.example.com/v1/rerank')

    const node = buildNonChatRequestCode(
      'node',
      '/v1/rerank',
      body,
      'https://api.example.com'
    )
    expect(node).toContain("fetch('https://api.example.com/v1/rerank'")
    expect(node).toContain('await response.json()')

    const json = buildNonChatRequestCode(
      'json',
      '/v1/rerank',
      body,
      'https://api.example.com'
    )
    expect(JSON.parse(json)).toEqual({
      model: 'rerank-model',
      query: 'hello',
      documents: ['a', 'b'],
    })
  })
})
