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
  TOOL_CALL_DENIED_CONTENT,
  TOOL_CALL_FAILED_CONTENT,
} from '../../constants'
import type { Message, MessageToolCall } from '../../types'
import { createToolContinuationMessages } from '../message/conversation-message-utils'
import { getMessageContentState } from '../message/message-content-utils'
import {
  applyToolCallDelta,
  canContinueToolCalls,
  getMessageToolCalls,
  getToolCallResponseContent,
  hasPendingToolCalls,
  setToolCallStatus,
  updateVersionToolCallStatus,
} from '../message/message-tool-call-utils'
import { normalizeMessagesForStorage } from '../storage/storage'
import { buildChatCompletionPayload } from '../streaming/payload-builder'

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    key: 'user-1',
    from: 'user',
    versions: [{ id: 'u1', content: 'What is the weather?' }],
    ...overrides,
  }
}

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    key: 'assistant-1',
    from: 'assistant',
    versions: [{ id: 'a1', content: '' }],
    status: 'complete',
    isContentComplete: true,
    ...overrides,
  }
}

function toolCall(overrides: Partial<MessageToolCall> = {}): MessageToolCall {
  return {
    id: 'call_weather',
    name: 'get_weather',
    arguments: '{"city":"Paris"}',
    status: 'pending',
    ...overrides,
  }
}

describe('streamed tool call fragments', () => {
  test('fragments merge into one call per index and tolerate repeated prefixes', () => {
    let message = applyToolCallDelta(assistantMessage(), {
      index: 0,
      id: 'call_1',
      function: { name: 'get_weather', arguments: '{"city"' },
    })
    message = applyToolCallDelta(message, {
      index: 0,
      function: { arguments: ':"Paris"}' },
    })
    // Some providers resend the accumulated text instead of only the delta.
    message = applyToolCallDelta(message, {
      index: 0,
      function: { arguments: '{"city":"Paris"}' },
    })

    expect(getMessageToolCalls(message)).toEqual([
      expect.objectContaining({
        id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
        status: 'pending',
      }),
    ])
    expect(message.status).toBe('streaming')
  })

  test('gapped stream indices are ignored so stored calls stay dense', () => {
    const gapped = applyToolCallDelta(assistantMessage(), {
      index: 2,
      id: 'call_3',
      function: { name: 'tool', arguments: '{}' },
    })
    expect(getMessageToolCalls(gapped)).toHaveLength(0)

    let message = applyToolCallDelta(assistantMessage(), {
      index: 0,
      id: 'call_1',
      function: { name: 'one', arguments: '{}' },
    })
    message = applyToolCallDelta(message, {
      index: 1,
      id: 'call_2',
      function: { name: 'two', arguments: '{}' },
    })
    expect(getMessageToolCalls(message).map((call) => call.id)).toEqual([
      'call_1',
      'call_2',
    ])
  })
})

describe('manual results and continuation', () => {
  test('response content reflects provided results, denials and failures', () => {
    expect(getToolCallResponseContent(toolCall())).toBe('')
    expect(
      getToolCallResponseContent(
        toolCall({ status: 'completed', result: 'Sunny, 21 C' })
      )
    ).toBe('Sunny, 21 C')
    expect(getToolCallResponseContent(toolCall({ status: 'denied' }))).toBe(
      TOOL_CALL_DENIED_CONTENT
    )
    expect(
      getToolCallResponseContent(
        toolCall({ status: 'error', errorMessage: 'Upstream timeout' })
      )
    ).toBe('Upstream timeout')
    expect(getToolCallResponseContent(toolCall({ status: 'error' }))).toBe(
      TOOL_CALL_FAILED_CONTENT
    )
  })

  test('answering one call leaves the other calls untouched', () => {
    const message = assistantMessage({
      versions: [
        {
          id: 'a1',
          content: '',
          toolCalls: [
            toolCall(),
            toolCall({ id: 'call_time', name: 'get_time' }),
          ],
        },
      ],
    })

    const answered = setToolCallStatus(
      message,
      'call_weather',
      'completed',
      'Sunny, 21 C'
    )
    const calls = getMessageToolCalls(answered)

    expect(calls[0]).toMatchObject({
      id: 'call_weather',
      status: 'completed',
      result: 'Sunny, 21 C',
    })
    expect(calls[0].completedAt).toBeTypeOf('number')
    expect(calls[1]).toMatchObject({ id: 'call_time', status: 'pending' })
    expect(calls[1].result).toBeUndefined()
  })

  test('pending calls gate continuation until every call is answered', () => {
    const reply = assistantMessage({
      versions: [
        {
          id: 'a1',
          content: '',
          toolCalls: [
            toolCall(),
            toolCall({ id: 'call_time', name: 'get_time' }),
          ],
        },
      ],
    })

    expect(hasPendingToolCalls([userMessage(), reply])).toBe(true)
    expect(canContinueToolCalls(reply)).toBe(false)
    // A later assistant turn ends the gate even if an older call stayed
    // pending.
    expect(
      hasPendingToolCalls([reply, userMessage(), assistantMessage()])
    ).toBe(false)

    let answered = setToolCallStatus(
      reply,
      'call_weather',
      'completed',
      'Sunny'
    )
    expect(canContinueToolCalls(answered)).toBe(false)
    answered = setToolCallStatus(answered, 'call_time', 'denied')
    expect(canContinueToolCalls(answered)).toBe(true)
    expect(hasPendingToolCalls([userMessage(), answered])).toBe(false)

    const continued = createToolContinuationMessages(
      [userMessage(), answered],
      42
    )
    expect(continued).toHaveLength(3)
    expect(continued.at(-1)).toMatchObject({
      from: 'assistant',
      status: 'loading',
      createdAt: 42,
    })
  })
})

describe('version-scoped tool call updates', () => {
  test('an outcome lands on the named version even when another one is active', () => {
    const reply = assistantMessage({
      activeVersionIndex: 1,
      versions: [
        { id: 'a1', content: '', toolCalls: [toolCall()] },
        {
          id: 'a2',
          content: '',
          toolCalls: [toolCall({ id: 'call_time', name: 'get_time' })],
        },
      ],
    })

    const updated = updateVersionToolCallStatus(
      [userMessage(), reply],
      'assistant-1',
      'a1',
      'call_weather',
      'completed',
      'Sunny, 21 C'
    )

    expect(updated[0].key).toBe('user-1')
    expect(updated[1].versions[0].toolCalls?.[0]).toMatchObject({
      status: 'completed',
      result: 'Sunny, 21 C',
    })
    expect(updated[1].versions[0].toolCalls?.[0].completedAt).toBeTypeOf(
      'number'
    )
    // The active version keeps its own pending call untouched.
    expect(getMessageToolCalls(updated[1])[0]).toMatchObject({
      id: 'call_time',
      status: 'pending',
    })
  })

  test('an error outcome stores the failure sentence for that version only', () => {
    const reply = assistantMessage({
      versions: [
        {
          id: 'a1',
          content: '',
          toolCalls: [
            toolCall({ status: 'completed', result: 'stale result' }),
          ],
        },
      ],
    })

    const updated = updateVersionToolCallStatus(
      [reply],
      'assistant-1',
      'a1',
      'call_weather',
      'error',
      undefined,
      'The tool call could not be executed.'
    )

    expect(getToolCallResponseContent(getMessageToolCalls(updated[0])[0])).toBe(
      'The tool call could not be executed.'
    )
    expect(getMessageToolCalls(updated[0])[0].result).toBeUndefined()
  })

  test('a message key or version id that does not match is left untouched', () => {
    const other = userMessage()
    const withUnknownKey = updateVersionToolCallStatus(
      [other],
      'assistant-1',
      'a1',
      'call_weather',
      'completed',
      'Sunny'
    )
    expect(withUnknownKey[0]).toBe(other)

    const reply = assistantMessage({
      versions: [{ id: 'a1', content: '', toolCalls: [toolCall()] }],
    })
    const withUnknownVersion = updateVersionToolCallStatus(
      [reply],
      'assistant-1',
      'a2',
      'call_weather',
      'completed',
      'Sunny'
    )
    expect(withUnknownVersion[0]).toBe(reply)
  })
})

describe('request payload and storage', () => {
  test('answered calls expand into tool_calls plus one tool message per answer', () => {
    const reply = assistantMessage({
      versions: [
        {
          id: 'a1',
          content: 'Checking the weather.',
          toolCalls: [
            toolCall({ status: 'completed', result: 'Sunny, 21 C' }),
            toolCall({
              id: 'call_time',
              name: 'get_time',
              arguments: '{"zone":"UTC"}',
              status: 'denied',
            }),
            toolCall({ id: 'call_open', name: 'open_page' }),
          ],
        },
      ],
    })

    const payload = buildChatCompletionPayload(
      [userMessage(), reply],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED
    )

    expect(payload.messages).toEqual([
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: 'Checking the weather.',
        tool_calls: [
          {
            id: 'call_weather',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
          {
            id: 'call_time',
            type: 'function',
            function: { name: 'get_time', arguments: '{"zone":"UTC"}' },
          },
        ],
      },
      { role: 'tool', content: 'Sunny, 21 C', tool_call_id: 'call_weather' },
      {
        role: 'tool',
        content: TOOL_CALL_DENIED_CONTENT,
        tool_call_id: 'call_time',
      },
    ])
  })

  test('storage keeps tool calls, results and a reply that has no text', () => {
    const reply = assistantMessage({
      versions: [
        {
          id: 'a1',
          content: '',
          toolCalls: [
            toolCall({
              status: 'completed',
              result: 'Sunny, 21 C',
              createdAt: 1,
              completedAt: 2,
            }),
            toolCall({
              id: 'call_time',
              name: 'get_time',
              status: 'error',
              errorMessage: 'Upstream timeout',
            }),
          ],
        },
      ],
    })

    const normalized = normalizeMessagesForStorage([reply])

    expect(normalized).toHaveLength(1)
    expect(normalized[0].versions[0].toolCalls).toEqual(
      reply.versions[0].toolCalls
    )
  })

  test('a tool-only branch version stays visible while the active one has none', () => {
    const message = assistantMessage({
      activeVersionIndex: 1,
      versions: [
        { id: 'a1', content: '', toolCalls: [toolCall()] },
        { id: 'a2', content: 'Regenerated answer' },
      ],
    })

    expect(
      getMessageContentState(message, '', message.versions[0])
        .showMessageContent
    ).toBe(true)
    expect(
      getMessageContentState(message, '', message.versions[1])
        .showMessageContent
    ).toBe(false)
  })
})
