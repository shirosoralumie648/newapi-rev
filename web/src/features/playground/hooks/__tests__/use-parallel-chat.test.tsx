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
import { beforeEach, expect, test, vi } from 'vitest'

import { sendChatCompletion, type ChatCompletionResult } from '../../api'
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
  ERROR_MESSAGES,
  MESSAGE_STATUS,
} from '../../constants'
import {
  applyParallelCompletionChoice,
  applyParallelVersionError,
  createParallelReplyMessage,
} from '../../lib'
import type { Message } from '../../types'
import { useParallelChat } from '../use-parallel-chat'

vi.mock('../../api', () => ({ sendChatCompletion: vi.fn() }))

function userMessage(content = 'Compare this'): Message {
  return { key: 'user-1', from: 'user', versions: [{ id: 'u1', content }] }
}

function completionResult(
  model: string,
  content: string
): ChatCompletionResult {
  return {
    response: {
      id: `c-${model}`,
      object: 'chat.completion',
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    requestId: `req-${model}`,
  }
}

function mount(initialMessages: Message[]) {
  let messages = initialMessages
  const onMessageUpdate = vi.fn((updater: (prev: Message[]) => Message[]) => {
    messages = updater(messages)
  })
  const hook = renderHook(() =>
    useParallelChat({
      config: DEFAULT_CONFIG,
      parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      systemPrompt: '',
      contextSettings: DEFAULT_CONTEXT_SETTINGS,
      messages: initialMessages,
      onMessageUpdate,
      sessionId: 'pgs_1',
    })
  )
  return { ...hook, current: () => messages }
}

beforeEach(() => {
  vi.mocked(sendChatCompletion).mockReset()
})

test('sends one independent request per compared model and stores each reply on its own version', async () => {
  vi.mocked(sendChatCompletion).mockImplementation(async (payload) =>
    completionResult(payload.model, `Answer from ${payload.model}`)
  )
  const messages = [
    userMessage(),
    createParallelReplyMessage(['gpt-4o', 'claude-mini'], 10),
  ]
  const { result, current } = mount(messages)

  await act(async () => {
    result.current.sendParallelChat(messages)
  })

  await waitFor(() => {
    expect(current()[1].versions.map((version) => version.status)).toEqual([
      MESSAGE_STATUS.COMPLETE,
      MESSAGE_STATUS.COMPLETE,
    ])
  })

  const calls = vi.mocked(sendChatCompletion).mock.calls
  expect(calls.map(([payload]) => payload.model)).toEqual([
    'gpt-4o',
    'claude-mini',
  ])
  expect(calls.every(([payload]) => payload.stream === false)).toBe(true)
  expect(current()[1]).toMatchObject({
    parallel: true,
    status: MESSAGE_STATUS.COMPLETE,
  })
  expect(current()[1].versions[0]).toMatchObject({
    content: 'Answer from gpt-4o',
    requestId: 'req-gpt-4o',
  })
  expect(current()[1].versions[1]).toMatchObject({
    content: 'Answer from claude-mini',
    requestId: 'req-claude-mini',
  })
})

test('a group with fewer than two labelled models never launches requests', async () => {
  const messages = [userMessage(), createParallelReplyMessage(['gpt-4o'], 10)]
  const { result } = mount(messages)

  await act(async () => {
    result.current.sendParallelChat(messages)
  })

  expect(sendChatCompletion).not.toHaveBeenCalled()
  expect(result.current.isComparing).toBe(false)
})

test('retrying one failed reply re-requests only its model and keeps the other answer', async () => {
  let group = createParallelReplyMessage(['gpt-4o', 'claude-mini'], 10)
  group = applyParallelCompletionChoice(group, 1, {
    index: 0,
    message: { role: 'assistant', content: 'Answer B' },
    finish_reason: 'stop',
  })
  group = applyParallelVersionError(
    group,
    0,
    'Upstream refused',
    'UPSTREAM_ERROR'
  )
  vi.mocked(sendChatCompletion).mockImplementation(async (payload) =>
    completionResult(payload.model, `Retried from ${payload.model}`)
  )
  const { result, current } = mount([userMessage(), group])

  await act(async () => {
    result.current.retryParallelVersion(group, 0)
  })

  await waitFor(() => {
    expect(current()[1].versions[0].status).toBe(MESSAGE_STATUS.COMPLETE)
  })

  const calls = vi.mocked(sendChatCompletion).mock.calls
  expect(calls).toHaveLength(1)
  expect(calls[0][0].model).toBe('gpt-4o')
  expect(calls[0][0].stream).toBe(false)
  expect(current()[1].versions[0].content).toBe('Retried from gpt-4o')
  expect(current()[1].versions[1].content).toBe('Answer B')
})

test('stopping settles replies that never arrived as interrupted and aborts the requests', async () => {
  let signal: AbortSignal | undefined
  vi.mocked(sendChatCompletion).mockImplementation(
    (_payload, requestSignal) => {
      signal = requestSignal
      return new Promise<ChatCompletionResult>(() => {})
    }
  )
  const messages = [
    userMessage(),
    createParallelReplyMessage(['gpt-4o', 'claude-mini'], 10),
  ]
  const { result, current } = mount(messages)

  await act(async () => {
    result.current.sendParallelChat(messages)
  })
  await waitFor(() => expect(result.current.isComparing).toBe(true))

  act(() => {
    result.current.stopComparison()
  })

  expect(result.current.isComparing).toBe(false)
  expect(signal?.aborted).toBe(true)
  await waitFor(() => {
    expect(current()[1].versions.map((version) => version.status)).toEqual([
      MESSAGE_STATUS.ERROR,
      MESSAGE_STATUS.ERROR,
    ])
  })
  expect(current()[1].versions[0].content).toContain(ERROR_MESSAGES.INTERRUPTED)
})

test('a reply that arrives after stopping never overwrites the interrupted state', async () => {
  const resolvers: Array<(result: ChatCompletionResult) => void> = []
  vi.mocked(sendChatCompletion).mockImplementation(() => {
    return new Promise<ChatCompletionResult>((resolve) => {
      resolvers.push(resolve)
    })
  })
  const messages = [
    userMessage(),
    createParallelReplyMessage(['gpt-4o', 'claude-mini'], 10),
  ]
  const { result, current } = mount(messages)

  await act(async () => {
    result.current.sendParallelChat(messages)
  })
  await waitFor(() => expect(resolvers).toHaveLength(2))

  act(() => {
    result.current.stopComparison()
  })
  await act(async () => {
    resolvers.forEach((resolve) =>
      resolve(completionResult('late', 'Late answer'))
    )
  })

  expect(current()[1].versions.map((version) => version.status)).toEqual([
    MESSAGE_STATUS.ERROR,
    MESSAGE_STATUS.ERROR,
  ])
  expect(current()[1].versions.map((version) => version.content)).not.toContain(
    'Late answer'
  )
})
