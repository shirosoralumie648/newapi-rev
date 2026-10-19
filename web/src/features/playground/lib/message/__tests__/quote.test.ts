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
  PLAYGROUND_QUOTE_TEXT_MAX_CHARS,
} from '../../../constants'
import type { Message } from '../../../types'
import { buildChatCompletionPayload } from '../../streaming/payload-builder'
import { buildQuoteRequestMessage, createPendingQuote } from '../quote-utils'

function message(overrides: Partial<Message> = {}): Message {
  return {
    key: 'm1',
    from: 'user',
    status: 'complete',
    versions: [{ id: 'v1', content: 'Hello canvas' }],
    ...overrides,
  }
}

describe('createPendingQuote', () => {
  test('snapshots the visible text of the active version', () => {
    const quoted = createPendingQuote(
      message({
        versions: [
          { id: 'v1', content: 'First draft' },
          { id: 'v2', content: 'Revised answer' },
        ],
        activeVersionIndex: 1,
      })
    )

    expect(quoted).toEqual({ messageKey: 'm1', text: 'Revised answer' })
  })

  test('caps an over-long snapshot at the quote limit', () => {
    const quoted = createPendingQuote(
      message({ versions: [{ id: 'v1', content: 'x'.repeat(5000) }] })
    )

    expect(quoted?.text).toHaveLength(PLAYGROUND_QUOTE_TEXT_MAX_CHARS)
  })

  test('refuses a message without visible text', () => {
    expect(
      createPendingQuote(message({ versions: [{ id: 'v1', content: '   ' }] }))
    ).toBeNull()
  })
})

describe('buildQuoteRequestMessage', () => {
  test('frames the snapshot with its source message key', () => {
    const requestMessage = buildQuoteRequestMessage({
      messageKey: 'm7',
      text: 'The checklist lives here',
    })

    expect(requestMessage).toEqual({
      role: 'user',
      content:
        '[quoted message: m7]\nThe checklist lives here\n[/quoted message]',
    })
  })

  test('turns a blank snapshot into nothing', () => {
    expect(
      buildQuoteRequestMessage({ messageKey: 'm7', text: '  ' })
    ).toBeNull()
  })
})

describe('quoted request payload', () => {
  test('leads the request with the quote ahead of the system prompt', () => {
    const payload = buildChatCompletionPayload(
      [message()],
      { ...DEFAULT_CONFIG },
      { ...DEFAULT_PARAMETER_ENABLED },
      'Be brief.',
      undefined,
      '',
      { messageKey: 'm1', text: 'Hello canvas' }
    )

    expect(payload.messages[0]).toEqual({
      role: 'user',
      content: '[quoted message: m1]\nHello canvas\n[/quoted message]',
    })
    expect(payload.messages[1]).toEqual({
      role: 'system',
      content: 'Be brief.',
    })
    expect(payload.messages[2]).toMatchObject({ role: 'user' })
  })

  test('leaves the request untouched without a pending quote', () => {
    const payload = buildChatCompletionPayload(
      [message()],
      { ...DEFAULT_CONFIG },
      { ...DEFAULT_PARAMETER_ENABLED },
      'Be brief.'
    )

    expect(payload.messages[0]).toEqual({
      role: 'system',
      content: 'Be brief.',
    })
    expect(payload.messages).toHaveLength(2)
  })
})
