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
  CONTINUE_GENERATION_INSTRUCTION,
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
} from '../../../constants'
import type { Message } from '../../../types'
import { buildChatCompletionPayload } from '../../streaming/payload-builder'
import { createContinuationMessages } from '../conversation-message-utils'
import {
  isMessageTruncated,
  setCurrentVersionFinishReason,
} from '../message-continuation-utils'

function truncatedAssistant(overrides: Partial<Message> = {}): Message {
  return {
    key: 'assistant-1',
    from: 'assistant',
    status: 'complete',
    versions: [
      {
        id: 'v1',
        content: 'The first half of the answer',
        finishReason: 'length',
      },
    ],
    ...overrides,
  }
}

const userMessage: Message = {
  key: 'user-1',
  from: 'user',
  versions: [{ id: 'u1', content: 'Explain the topic' }],
}

test('a length or interrupted finish reason marks the active version truncated', () => {
  expect(isMessageTruncated(truncatedAssistant())).toBe(true)
  expect(
    isMessageTruncated(
      truncatedAssistant({
        versions: [{ id: 'v1', content: 'cut', finishReason: 'interrupted' }],
      })
    )
  ).toBe(true)
  expect(
    isMessageTruncated(
      truncatedAssistant({
        versions: [{ id: 'v1', content: 'done', finishReason: 'stop' }],
      })
    )
  ).toBe(false)
})

test('the finish reason only labels the active branch', () => {
  const message: Message = {
    key: 'assistant-1',
    from: 'assistant',
    activeVersionIndex: 1,
    versions: [
      { id: 'v1', content: 'old', finishReason: 'length' },
      { id: 'v2', content: 'new' },
    ],
  }

  const labelled = setCurrentVersionFinishReason(message, 'interrupted')

  expect(labelled.versions[0].finishReason).toBe('length')
  expect(labelled.versions[1].finishReason).toBe('interrupted')
  expect(setCurrentVersionFinishReason(message, '')).toBe(message)
})

test('continuing keeps the truncated version and appends a fresh empty branch', () => {
  const messages = [userMessage, truncatedAssistant()]

  const plan = createContinuationMessages(messages, 'assistant-1')

  expect(plan).not.toBeNull()
  if (!plan) return

  const continued = plan.stateMessages.at(-1)
  expect(continued?.versions).toHaveLength(2)
  expect(continued?.versions[0]).toMatchObject({
    content: 'The first half of the answer',
    finishReason: 'length',
  })
  expect(continued?.activeVersionIndex).toBe(1)
  // The new branch starts with the truncated text so it reads as the complete
  // answer once the continuation is appended.
  expect(continued?.versions[1].content).toBe('The first half of the answer')
  expect(continued?.status).toBe('loading')
  expect(plan.prefix).toBe('The first half of the answer')

  // The request still carries the truncated answer as the final assistant turn
  // (assistant prefill), and the fallback adds one user instruction instead.
  expect(plan.prefillMessages.at(-1)?.versions[0].content).toBe(
    'The first half of the answer'
  )
  expect(plan.fallbackMessages.at(-1)).toMatchObject({
    from: 'user',
    versions: [{ content: CONTINUE_GENERATION_INSTRUCTION }],
  })
  const payload = buildChatCompletionPayload(
    plan.prefillMessages,
    DEFAULT_CONFIG,
    DEFAULT_PARAMETER_ENABLED
  )
  expect(payload.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: 'The first half of the answer',
  })
})

test('continuation is refused unless the last reply is a truncated assistant answer', () => {
  expect(createContinuationMessages([userMessage], 'user-1')).toBeNull()
  expect(
    createContinuationMessages(
      [userMessage, truncatedAssistant({ status: 'streaming' })],
      'assistant-1'
    )
  ).toBeNull()
  expect(
    createContinuationMessages(
      [
        userMessage,
        truncatedAssistant({ versions: [{ id: 'v1', content: '' }] }),
      ],
      'assistant-1'
    )
  ).toBeNull()
  expect(
    createContinuationMessages(
      [
        userMessage,
        truncatedAssistant({
          versions: [{ id: 'v1', content: 'done', finishReason: 'stop' }],
        }),
      ],
      'assistant-1'
    )
  ).toBeNull()
  // Only the last message can continue: streaming handlers target the newest
  // assistant message, so an older truncated reply cannot start a request.
  expect(
    createContinuationMessages(
      [truncatedAssistant(), { ...userMessage, key: 'user-2' }],
      'assistant-1'
    )
  ).toBeNull()
})
