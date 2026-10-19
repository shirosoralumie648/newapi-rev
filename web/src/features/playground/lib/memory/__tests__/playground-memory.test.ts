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
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  PLAYGROUND_MEMORY_CONTEXT_CLOSE,
  PLAYGROUND_MEMORY_CONTEXT_HINT,
  PLAYGROUND_MEMORY_CONTEXT_OPEN,
  PLAYGROUND_MEMORY_EXTRACTION_INPUT_MAX_CHARS,
  PLAYGROUND_MEMORY_EXTRACTION_SYSTEM_PROMPT,
} from '../../../constants'
import type { Message, PlaygroundMemory } from '../../../types'
import { buildChatCompletionPayload } from '../../streaming/payload-builder'
import {
  buildMemoryExtractionRequest,
  diffMemoryCandidates,
  formatMemoryBlock,
  parseMemoryExtractionResponse,
} from '../playground-memory'

function memory(overrides: Partial<PlaygroundMemory> = {}): PlaygroundMemory {
  return {
    id: 'pgm_1',
    content: 'Prefers concise answers.',
    category: 'preference',
    sourceSessionId: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function message(
  key: string,
  content: string,
  from: 'user' | 'assistant' = 'user'
): Message {
  return { key, from, versions: [{ id: `${key}-v1`, content }] }
}

describe('memory block', () => {
  test('only enabled non-empty memories reach the request block', () => {
    expect(formatMemoryBlock([])).toBe('')
    expect(
      formatMemoryBlock([
        memory(),
        memory({ id: 'pgm_2', content: '  ', category: 'general' }),
        memory({ id: 'pgm_3', content: 'Disabled note.', enabled: false }),
      ])
    ).toBe(
      [
        PLAYGROUND_MEMORY_CONTEXT_OPEN,
        PLAYGROUND_MEMORY_CONTEXT_HINT,
        '- [preference] Prefers concise answers.',
        PLAYGROUND_MEMORY_CONTEXT_CLOSE,
      ].join('\n')
    )
  })

  test('the payload places the memory block after the system prompt', () => {
    const payload = buildChatCompletionPayload(
      [message('m1', 'Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      'Be concise.',
      undefined,
      formatMemoryBlock([memory()])
    )

    expect(payload.messages[0]).toEqual({
      role: 'system',
      content: 'Be concise.',
    })
    expect(payload.messages[1]).toMatchObject({
      role: 'system',
      content: expect.stringContaining(PLAYGROUND_MEMORY_CONTEXT_OPEN),
    })
    expect(payload.messages[2]).toMatchObject({
      role: 'user',
      content: 'Hello',
    })
  })
})

describe('extraction response', () => {
  test('fenced JSON is validated, de-duplicated and normalized', () => {
    const content = [
      '```json',
      JSON.stringify({
        memories: [
          {
            id: ' pgm_1 ',
            content: ' Prefers short answers. ',
            category: 'preference',
          },
          { content: 'Prefers short answers.', category: 'preference' },
          { content: '', category: 'general' },
          { content: 'Uses TypeScript daily.', category: 'not-a-category' },
          { content: 42, category: 'general' },
        ],
      }),
      '```',
    ].join('\n')

    expect(parseMemoryExtractionResponse(content)).toEqual([
      {
        id: 'pgm_1',
        content: 'Prefers short answers.',
        category: 'preference',
      },
      {
        id: '',
        content: 'Uses TypeScript daily.',
        category: 'general',
      },
    ])
  })

  test('a bare array is accepted and malformed JSON is ignored', () => {
    expect(
      parseMemoryExtractionResponse(
        '[{"content":"Lives in Berlin.","category":"profile"}]'
      )
    ).toEqual([{ id: '', content: 'Lives in Berlin.', category: 'profile' }])
    expect(parseMemoryExtractionResponse('not json')).toEqual([])
    expect(parseMemoryExtractionResponse('{"memories":[]}')).toEqual([])
  })
})

describe('candidate diff', () => {
  const existing = [
    memory(),
    memory({ id: 'pgm_2', content: 'Old project note.', category: 'project' }),
  ]

  test('known ids update, new text creates, duplicates and the budget are respected', () => {
    const plan = diffMemoryCandidates(
      existing,
      [
        {
          id: 'pgm_1',
          content: 'Prefers concise answers.',
          category: 'preference',
        },
        {
          id: 'pgm_2',
          content: 'Current project note.',
          category: 'project',
        },
        { id: '', content: 'Uses TypeScript daily.', category: 'general' },
        { id: '', content: 'Uses TypeScript daily.', category: 'general' },
        { id: 'pgm_deleted', content: 'Second new note.', category: 'general' },
      ],
      1
    )

    expect(plan.updates).toEqual([
      {
        id: 'pgm_2',
        content: 'Current project note.',
        category: 'project',
      },
    ])
    expect(plan.creates).toEqual([
      { content: 'Uses TypeScript daily.', category: 'general' },
    ])
  })

  test('no free slot still applies updates but creates nothing', () => {
    const plan = diffMemoryCandidates(
      existing,
      [
        {
          id: 'pgm_1',
          content: 'Updated preference.',
          category: 'preference',
        },
        { id: '', content: 'Brand new note.', category: 'general' },
      ],
      0
    )

    expect(plan.updates).toHaveLength(1)
    expect(plan.creates).toEqual([])
  })
})

describe('extraction request', () => {
  test('sends only user messages with the existing ids and the configured model', () => {
    const request = buildMemoryExtractionRequest({
      messages: [
        message('m1', 'I prefer short answers.'),
        message('a1', 'Understood.', 'assistant'),
        message('m2', 'I work in TypeScript.'),
      ],
      memories: [memory()],
      model: 'memory-model',
      group: 'pro',
    })

    expect(request).toMatchObject({
      model: 'memory-model',
      group: 'pro',
      stream: false,
    })
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: PLAYGROUND_MEMORY_EXTRACTION_SYSTEM_PROMPT,
    })
    expect(request.messages[1].content).toContain(
      'pgm_1 | preference | Prefers concise answers.'
    )
    expect(request.messages.slice(2)).toEqual([
      { role: 'user', content: 'I prefer short answers.' },
      { role: 'user', content: 'I work in TypeScript.' },
    ])
  })

  test('the input window keeps the newest user text within the character cap', () => {
    const long = 'x'.repeat(PLAYGROUND_MEMORY_EXTRACTION_INPUT_MAX_CHARS + 50)
    const request = buildMemoryExtractionRequest({
      messages: [message('old', 'Older message.'), message('new', long)],
      memories: [],
      model: 'memory-model',
      group: 'default',
    })

    expect(request.messages).toHaveLength(2)
    expect(request.messages[1].content).toHaveLength(
      PLAYGROUND_MEMORY_EXTRACTION_INPUT_MAX_CHARS
    )
    expect(request.messages[1].content).toBe(
      long.slice(long.length - PLAYGROUND_MEMORY_EXTRACTION_INPUT_MAX_CHARS)
    )
  })
})
