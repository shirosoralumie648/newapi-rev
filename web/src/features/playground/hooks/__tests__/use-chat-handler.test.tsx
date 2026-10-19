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
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { sendChatCompletion } from '../../api'
import {
  CONTINUE_GENERATION_INSTRUCTION,
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
} from '../../constants'
import type { Message } from '../../types'
import { useChatHandler } from '../use-chat-handler'

vi.mock('../../api', () => ({ sendChatCompletion: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

const userMessage: Message = {
  key: 'user-1',
  from: 'user',
  versions: [{ id: 'u1', content: 'Tell me a story' }],
}

const truncated: Message = {
  key: 'assistant-1',
  from: 'assistant',
  status: 'complete',
  versions: [{ id: 'a1', content: 'Once upon a time', finishReason: 'length' }],
}

test('a rejected assistant prefill retries once with a user continue instruction', async () => {
  vi.mocked(sendChatCompletion)
    .mockRejectedValueOnce(new Error('Assistant prefill is not supported'))
    .mockResolvedValueOnce({
      response: {
        id: 'chatcmpl-2',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: ' and they lived.' },
            finish_reason: 'stop',
          },
        ],
      },
      requestId: 'req-2',
    })
  // The caller already appended the continuation branch, which starts from the
  // truncated text. It stays the last message while the request runs.
  let current: Message[] = [
    userMessage,
    {
      key: 'assistant-1',
      from: 'assistant',
      status: 'loading',
      versions: [{ id: 'a2', content: 'Once upon a time' }],
    },
  ]
  const onResponseComplete = vi.fn()
  const hook = renderHook(() =>
    useChatHandler({
      config: { ...DEFAULT_CONFIG, stream: false },
      parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
      systemPrompt: '',
      contextSettings: { ...DEFAULT_CONTEXT_SETTINGS },
      onMessageUpdate: (updater) => {
        current = typeof updater === 'function' ? updater(current) : updater
      },
      onResponseComplete,
      sessionId: 'session-1',
    })
  )
  const fallback = [
    userMessage,
    truncated,
    {
      key: 'continue-1',
      from: 'user' as const,
      versions: [
        { id: 'continue-v1', content: CONTINUE_GENERATION_INSTRUCTION },
      ],
    },
  ]

  act(() => {
    hook.result.current.continueChat(
      [userMessage, truncated],
      fallback,
      'Once upon a time'
    )
  })

  await waitFor(() => expect(sendChatCompletion).toHaveBeenCalledTimes(2))
  const firstPayload = vi.mocked(sendChatCompletion).mock.calls[0][0]
  expect(firstPayload.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: 'Once upon a time',
  })
  const secondPayload = vi.mocked(sendChatCompletion).mock.calls[1][0]
  expect(secondPayload.messages.at(-1)).toMatchObject({
    role: 'user',
    content: CONTINUE_GENERATION_INSTRUCTION,
  })
  // The new branch holds the complete answer, not only the continuation.
  await waitFor(() =>
    expect(current.at(-1)?.versions.at(-1)?.content).toBe(
      'Once upon a time and they lived.'
    )
  )
  expect(onResponseComplete).toHaveBeenCalledWith(
    expect.objectContaining({
      content: 'Once upon a time and they lived.',
      finishReason: 'stop',
    })
  )
})

test('a stopped reply keeps its text and is labelled interrupted', () => {
  vi.mocked(sendChatCompletion).mockResolvedValue({
    response: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Half' },
          finish_reason: 'length',
        },
      ],
    },
    requestId: 'req-1',
  })
  const updates: Message[][] = []
  const hook = renderHook(() =>
    useChatHandler({
      config: { ...DEFAULT_CONFIG, stream: false },
      parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
      systemPrompt: '',
      contextSettings: { ...DEFAULT_CONTEXT_SETTINGS },
      onMessageUpdate: (updater) => {
        updates.push(
          typeof updater === 'function'
            ? updater([
                userMessage,
                {
                  ...truncated,
                  status: 'streaming',
                  versions: [{ id: 'a1', content: 'Once upon a time' }],
                },
              ])
            : updater
        )
      },
      sessionId: 'session-1',
    })
  )

  act(() => hook.result.current.stopGeneration())

  const stopped = updates.at(-1)?.at(-1)
  expect(stopped?.status).toBe('complete')
  expect(stopped?.versions.at(-1)).toMatchObject({
    content: 'Once upon a time',
    finishReason: 'interrupted',
  })
})
