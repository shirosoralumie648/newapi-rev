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
import { afterEach, expect, test } from 'vitest'

import {
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  HISTORY_IMAGE_OMITTED_CONTENT,
  INLINE_BASE64_OMITTED_CONTENT,
} from '../../../constants'
import type { ChatCompletionMessage, Message } from '../../../types'
import {
  clearPlaygroundAttachmentCache,
  primePlaygroundAttachment,
} from '../../attachment-store'
import { buildChatCompletionPayload } from '../../streaming/payload-builder'
import {
  applyModelMediaPolicy,
  modelAcceptsImageInput,
  omitInlineBase64Media,
} from '../message-media-utils'

const PNG_BASE64 = 'iVBORw0KGgo='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

afterEach(() => {
  clearPlaygroundAttachmentCache()
})

test('inline base64 media is replaced in every shape and counted', () => {
  const input = [
    `before ![chart](${PNG_DATA_URL})`,
    '[media](data:video/mp4;base64,BBBB)',
    `<img alt="shot" src="${PNG_DATA_URL}">`,
    'tail data:image/webp;base64,CCCC end',
  ].join(' ')

  const result = omitInlineBase64Media(input)

  expect(result.omitted).toBe(4)
  expect(result.text).not.toContain('base64')
  expect(result.text.match(/\[inline base64 media omitted\]/g)).toHaveLength(4)
})

test('ordinary text and non-base64 URLs are left alone', () => {
  const input = 'See https://example.com/image.png and data:text/plain,hello'
  expect(omitInlineBase64Media(input)).toEqual({ text: input, omitted: 0 })
})

test('vision families are recognized before their text-only relatives', () => {
  const cases: Array<[string, boolean]> = [
    ['gpt-4o', true],
    ['gpt-4-turbo', true],
    ['claude-3-5-sonnet-20241022', true],
    ['gemini-2.5-pro', true],
    ['qwen2.5-vl-72b-instruct', true],
    ['glm-4.5v', true],
    ['gpt-4', false],
    ['deepseek-chat', false],
    ['deepseek-reasoner', false],
    ['qwen2.5-72b-instruct', false],
    ['glm-4.6', false],
    ['o1-mini', false],
    ['brand-new-model', true],
    ['', true],
  ]

  for (const [model, expected] of cases) {
    expect(modelAcceptsImageInput(model), model).toBe(expected)
  }
})

test('a text-only model replaces history images but keeps the newest attachments', () => {
  const messages: ChatCompletionMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      ],
    },
    { role: 'assistant', content: 'seen' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'second' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      ],
    },
  ]

  const result = applyModelMediaPolicy(messages, 'deepseek-chat')

  expect(result.omittedHistoryImages).toBe(1)
  expect(result.messages[0].content).toEqual([
    { type: 'text', text: 'first' },
    { type: 'text', text: HISTORY_IMAGE_OMITTED_CONTENT },
  ])
  expect(result.messages[2].content).toEqual([
    { type: 'text', text: 'second' },
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
  ])
  // Stored request messages are never mutated.
  expect(messages[0].content).toHaveLength(2)
})

test('a vision model keeps image parts and only scrubs inline base64 text', () => {
  const messages: ChatCompletionMessage[] = [
    { role: 'assistant', content: `Generated ![image](${PNG_DATA_URL})` },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'next' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      ],
    },
  ]

  const result = applyModelMediaPolicy(messages, 'gpt-4o')

  expect(result.omittedHistoryImages).toBe(0)
  expect(result.omittedInlineImages).toBe(1)
  expect(result.messages[0].content).toBe(
    `Generated ${INLINE_BASE64_OMITTED_CONTENT}`
  )
  expect(result.messages[1].content).toEqual([
    { type: 'text', text: 'next' },
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
  ])
})

test('an unknown model keeps every structured image', () => {
  const messages: ChatCompletionMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      ],
    },
    { role: 'user', content: 'next' },
  ]

  const result = applyModelMediaPolicy(messages, 'brand-new-model')

  expect(result.omittedImages).toBe(0)
  expect(result.messages[0].content).toEqual(messages[0].content)
})

test('a payload scrubs generated history media and keeps the current attachment', () => {
  primePlaygroundAttachment('pgf_current', PNG_DATA_URL)
  const history: Message[] = [
    {
      key: 'm1',
      from: 'assistant',
      versions: [{ id: 'v1', content: `Chart: ![image](${PNG_DATA_URL})` }],
    },
    {
      key: 'm2',
      from: 'user',
      versions: [
        {
          id: 'v2',
          content: 'next',
          attachments: [
            {
              id: 'pgf_current',
              url: '/api/playground/sessions/s/attachments/pgf_current/content',
              mediaType: 'image/png',
            },
          ],
        },
      ],
    },
  ]

  const payload = buildChatCompletionPayload(
    history,
    { ...DEFAULT_CONFIG, model: 'gpt-4o' },
    DEFAULT_PARAMETER_ENABLED
  )

  expect(payload.messages[0]).toEqual({
    role: 'assistant',
    content: `Chart: ${INLINE_BASE64_OMITTED_CONTENT}`,
  })
  expect(payload.messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'next' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
    ],
  })
  // The stored message keeps its original text; only the request is adjusted.
  expect(history[0].versions[0].content).toBe(
    `Chart: ![image](${PNG_DATA_URL})`
  )
})

test('a payload leaves out history images for a text-only model', () => {
  primePlaygroundAttachment('pgf_old', PNG_DATA_URL)
  primePlaygroundAttachment('pgf_current', PNG_DATA_URL)
  const history: Message[] = [
    {
      key: 'm1',
      from: 'user',
      versions: [
        {
          id: 'v1',
          content: 'older',
          attachments: [{ id: 'pgf_old', url: '/old', mediaType: 'image/png' }],
        },
      ],
    },
    { key: 'm2', from: 'assistant', versions: [{ id: 'v2', content: 'seen' }] },
    {
      key: 'm3',
      from: 'user',
      versions: [
        {
          id: 'v3',
          content: 'now',
          attachments: [
            { id: 'pgf_current', url: '/current', mediaType: 'image/png' },
          ],
        },
      ],
    },
  ]

  const payload = buildChatCompletionPayload(
    history,
    { ...DEFAULT_CONFIG, model: 'deepseek-chat' },
    DEFAULT_PARAMETER_ENABLED
  )

  expect(payload.messages[0].content).toEqual([
    { type: 'text', text: 'older' },
    { type: 'text', text: HISTORY_IMAGE_OMITTED_CONTENT },
  ])
  expect(payload.messages[1]).toEqual({ role: 'assistant', content: 'seen' })
  expect(payload.messages[2].content).toEqual([
    { type: 'text', text: 'now' },
    { type: 'image_url', image_url: { url: PNG_DATA_URL } },
  ])
})
