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
  PLAYGROUND_MESSAGE_TOKEN_MAX,
  PLAYGROUND_REQUEST_ID_MAX_LENGTH,
} from '../../../constants'
import type { Message, PlaygroundMessageCost } from '../../../types'
import {
  MESSAGE_COST_LOOKUP_MAX_REQUEST_IDS,
  attachMessageVersionUsage,
  collectMessageRequestIds,
  getVersionUsage,
  normalizeMessageRequestId,
  sumConversationUsage,
  toMessageUsage,
} from '../message-usage-utils'

function cost(
  overrides: Partial<PlaygroundMessageCost>
): PlaygroundMessageCost {
  return {
    requestId: 'req-1',
    quota: 100,
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    modelName: 'test-model',
    createdAt: 1,
    ...overrides,
  }
}

describe('message generation record', () => {
  test('records usage on the active version without touching earlier branches', () => {
    const message: Message = {
      key: 'assistant-1',
      from: 'assistant',
      activeVersionIndex: 1,
      versions: [
        { id: 'v1', content: 'First answer' },
        { id: 'v2', content: 'Regenerated answer' },
      ],
    }

    const updated = attachMessageVersionUsage(message, {
      requestId: 'req-2',
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
    })

    expect(updated.versions[0].requestId).toBeUndefined()
    expect(updated.versions[0].usage).toBeUndefined()
    expect(updated.versions[1].requestId).toBe('req-2')
    expect(updated.versions[1].usage).toEqual({
      promptTokens: 5,
      completionTokens: 6,
      totalTokens: 11,
    })
  })

  test('keeps a request id without usage and leaves user messages alone', () => {
    const assistant: Message = {
      key: 'assistant-1',
      from: 'assistant',
      versions: [{ id: 'v1', content: 'Answer' }],
    }
    const user: Message = {
      key: 'user-1',
      from: 'user',
      versions: [{ id: 'u1', content: 'Question' }],
    }

    const withRequestId = attachMessageVersionUsage(assistant, {
      requestId: 'req-3',
    })
    expect(withRequestId.versions[0].requestId).toBe('req-3')
    expect(withRequestId.versions[0].usage).toBeUndefined()
    expect(attachMessageVersionUsage(user, { requestId: 'req-3' })).toBe(user)
    expect(attachMessageVersionUsage(assistant, {})).toBe(assistant)
    expect(attachMessageVersionUsage(assistant, { requestId: '   ' })).toBe(
      assistant
    )
  })

  test('drops values the stored record cannot hold', () => {
    const message: Message = {
      key: 'assistant-1',
      from: 'assistant',
      versions: [{ id: 'v1', content: 'Answer' }],
    }

    // An id longer than logs.request_id cannot be looked up afterwards.
    expect(normalizeMessageRequestId(`  req-1  `)).toBe('req-1')
    expect(normalizeMessageRequestId('')).toBeUndefined()
    expect(
      normalizeMessageRequestId(
        'r'.repeat(PLAYGROUND_REQUEST_ID_MAX_LENGTH + 1)
      )
    ).toBeUndefined()

    const oversized = attachMessageVersionUsage(message, {
      requestId: 'r'.repeat(PLAYGROUND_REQUEST_ID_MAX_LENGTH + 1),
      usage: {
        promptTokens: PLAYGROUND_MESSAGE_TOKEN_MAX + 1,
        completionTokens: 1,
        totalTokens: 1,
      },
    })
    expect(oversized).toBe(message)

    const bounded = attachMessageVersionUsage(message, {
      requestId: 'r'.repeat(PLAYGROUND_REQUEST_ID_MAX_LENGTH),
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    })
    expect(bounded.versions[0].requestId).toHaveLength(
      PLAYGROUND_REQUEST_ID_MAX_LENGTH
    )
    expect(bounded.versions[0].usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    })
  })

  test('normalizes the wire usage and rejects an incomplete frame', () => {
    expect(toMessageUsage({ prompt_tokens: 1, completion_tokens: 2 })).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    })
    expect(
      toMessageUsage({
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 9,
      })
    ).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 9 })
    expect(toMessageUsage({ prompt_tokens: 1 })).toBeUndefined()
    expect(toMessageUsage(undefined)).toBeUndefined()
    expect(
      toMessageUsage({
        prompt_tokens: Number.NaN,
        completion_tokens: 2,
        total_tokens: 2,
      })
    ).toBeUndefined()
  })

  test('collects unique request ids in a stable order and stops at the lookup bound', () => {
    const message: Message = {
      key: 'm',
      from: 'assistant',
      versions: [
        { id: 'v1', content: 'a', requestId: 'req-b' },
        { id: 'v2', content: 'b', requestId: 'req-a' },
        { id: 'v3', content: 'c' },
      ],
    }
    const other: Message = {
      key: 'm2',
      from: 'assistant',
      versions: [{ id: 'v1', content: 'd', requestId: 'req-b' }],
    }

    expect(collectMessageRequestIds([message, other])).toEqual([
      'req-a',
      'req-b',
    ])

    const versions = Array.from(
      { length: MESSAGE_COST_LOOKUP_MAX_REQUEST_IDS + 5 },
      (_value, index) => ({
        id: `v${index}`,
        content: '',
        requestId: `req-${String(index).padStart(3, '0')}`,
      })
    )
    const bounded = collectMessageRequestIds([
      { key: 'many', from: 'assistant', versions },
    ])
    expect(bounded).toHaveLength(MESSAGE_COST_LOOKUP_MAX_REQUEST_IDS)
  })
})

describe('conversation usage totals', () => {
  const messages: Message[] = [
    {
      key: 'user-1',
      from: 'user',
      versions: [{ id: 'u1', content: 'Question' }],
    },
    {
      key: 'assistant-1',
      from: 'assistant',
      versions: [
        {
          id: 'a1',
          content: 'First answer',
          requestId: 'req-old',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        {
          id: 'a2',
          content: 'Regenerated answer',
          requestId: 'req-new',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        },
      ],
      activeVersionIndex: 1,
    },
  ]

  test('totals only the version each message displays', () => {
    const costs = new Map<string, PlaygroundMessageCost>([
      ['req-old', cost({ requestId: 'req-old', quota: 500 })],
      ['req-new', cost({ requestId: 'req-new', quota: 250 })],
    ])

    const summary = sumConversationUsage(messages, costs)
    expect(summary.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    })
    expect(summary.quota).toBe(250)
    expect(summary.hasUsage).toBe(true)
    expect(summary.hasCost).toBe(true)
  })

  test('falls back to the settle row and reports a conversation without records', () => {
    const imported: Message = {
      key: 'assistant-imported',
      from: 'assistant',
      versions: [
        { id: 'a3', content: 'Imported answer', requestId: 'req-imported' },
      ],
    }
    const summary = sumConversationUsage(
      [imported],
      new Map([
        [
          'req-imported',
          cost({
            requestId: 'req-imported',
            promptTokens: 5,
            completionTokens: 6,
            totalTokens: 11,
            quota: 42,
          }),
        ],
      ])
    )
    expect(summary.usage).toEqual({
      promptTokens: 5,
      completionTokens: 6,
      totalTokens: 11,
    })
    expect(summary.quota).toBe(42)
    expect(summary.hasUsage).toBe(true)
    expect(summary.hasCost).toBe(true)
    expect(getVersionUsage(imported.versions[0])).toBeUndefined()

    const empty = sumConversationUsage([messages[0]])
    expect(empty.hasUsage).toBe(false)
    expect(empty.hasCost).toBe(false)
    expect(empty.usage.totalTokens).toBe(0)
  })
})
