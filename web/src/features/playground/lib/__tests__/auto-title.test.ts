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

import {
  PLAYGROUND_AUTO_TITLE_INPUT_MAX_CHARS,
  PLAYGROUND_AUTO_TITLE_MAX_LENGTH,
  PLAYGROUND_AUTO_TITLE_MAX_TOKENS,
  PLAYGROUND_AUTO_TITLE_SYSTEM_PROMPT,
} from '../../constants'
import type { Message } from '../../types'
import {
  buildAutoTitleRequest,
  parseAutoTitleResponse,
} from '../title/auto-title'

const messages: Message[] = [
  {
    key: 'u1',
    from: 'user',
    versions: [{ id: 'u1-v1', content: 'Plan my trip to Kyoto.' }],
  },
  {
    key: 'a1',
    from: 'assistant',
    status: 'complete',
    versions: [{ id: 'a1-v1', content: 'An early draft itinerary.' }],
  },
  {
    key: 'u2',
    from: 'user',
    versions: [{ id: 'u2-v1', content: 'Add a food section.' }],
  },
  {
    key: 'a2',
    from: 'assistant',
    status: 'complete',
    versions: [
      {
        id: 'a2-v1',
        content: 'A food-focused itinerary with market visits.',
      },
    ],
  },
]

test('builds a bounded non-streaming request from the first question and latest completed reply', () => {
  const request = buildAutoTitleRequest({
    messages,
    model: ' summary-model ',
    group: 'vip',
  })

  expect(request).not.toBeNull()
  expect(request).toMatchObject({
    model: 'summary-model',
    group: 'vip',
    stream: false,
    temperature: 0.3,
    max_tokens: PLAYGROUND_AUTO_TITLE_MAX_TOKENS,
  })
  expect(request?.messages[0]).toEqual({
    role: 'system',
    content: PLAYGROUND_AUTO_TITLE_SYSTEM_PROMPT,
  })
  const input = String(request?.messages[1]?.content)
  expect(input).toContain('Plan my trip to Kyoto.')
  expect(input).toContain('A food-focused itinerary with market visits.')
  expect(input).not.toContain('An early draft itinerary.')
})

test('skips pending, failed and interrupted replies and stays within the input bound', () => {
  expect(
    buildAutoTitleRequest({
      messages: [
        messages[0],
        {
          key: 'a1',
          from: 'assistant',
          status: 'streaming',
          versions: [{ id: 'a1-v1', content: 'Still streaming.' }],
        },
        {
          key: 'a2',
          from: 'assistant',
          status: 'complete',
          versions: [
            {
              id: 'a2-v1',
              content: 'Stopped reply.',
              finishReason: 'interrupted',
            },
          ],
        },
      ],
      model: 'summary-model',
      group: 'default',
    })
  ).toBeNull()

  const longRequest = buildAutoTitleRequest({
    messages: [
      {
        key: 'u1',
        from: 'user',
        versions: [{ id: 'u1-v1', content: 'u'.repeat(3000) }],
      },
      {
        key: 'a1',
        from: 'assistant',
        status: 'complete',
        versions: [{ id: 'a1-v1', content: 'a'.repeat(3000) }],
      },
    ],
    model: 'summary-model',
    group: 'default',
  })
  const input = String(longRequest?.messages[1]?.content)
  expect(input).toHaveLength(PLAYGROUND_AUTO_TITLE_INPUT_MAX_CHARS)
})

test('requires a model, a user message and a completed assistant reply', () => {
  expect(
    buildAutoTitleRequest({ messages, model: '  ', group: 'default' })
  ).toBeNull()
  expect(
    buildAutoTitleRequest({
      messages: messages.filter((message) => message.from === 'assistant'),
      model: 'summary-model',
      group: 'default',
    })
  ).toBeNull()
  expect(
    buildAutoTitleRequest({
      messages: messages.filter((message) => message.from === 'user'),
      model: 'summary-model',
      group: 'default',
    })
  ).toBeNull()
})

test('normalizes a model answer into one plain title', () => {
  expect(
    parseAutoTitleResponse('```\nTitle: "Kyoto Food Itinerary"\n```')
  ).toBe('Kyoto Food Itinerary')
  expect(parseAutoTitleResponse('  ##   Kyoto\nFood plan  ')).toBe('Kyoto')
  expect(parseAutoTitleResponse('“Kyoto   food market”')).toBe(
    'Kyoto food market'
  )
  expect(parseAutoTitleResponse('   \n ')).toBeNull()
})

test('bounds a title to 50 characters without splitting a code point', () => {
  expect(parseAutoTitleResponse('x'.repeat(80))).toBe(
    'x'.repeat(PLAYGROUND_AUTO_TITLE_MAX_LENGTH)
  )
  expect(parseAutoTitleResponse('😀'.repeat(60))).toBe('😀'.repeat(50))
})
