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
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { sendChatCompletion } from '../../api'
import { DEFAULT_CONFIG, DEFAULT_CONTEXT_SETTINGS } from '../../constants'
import type {
  Message,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../../types'
import { usePlaygroundContext } from '../use-playground-context'

vi.mock('../../api', () => ({ sendChatCompletion: vi.fn() }))

function message(key: string, content: string): Message {
  return { key, from: 'user', versions: [{ id: `${key}-v1`, content }] }
}

const messages = [message('m1', 'first'), message('m2', 'second')]

function settings(
  overrides: Partial<PlaygroundContextSettings> = {}
): PlaygroundContextSettings {
  return {
    ...DEFAULT_CONTEXT_SETTINGS,
    historyLimit: 1,
    autoSummarize: true,
    summaryModel: 'summary-model',
    ...overrides,
  }
}

function completionResult(content: string, requestId = 'req-1') {
  return {
    response: {
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'summary-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    requestId,
  }
}

function mount(
  contextSettings: PlaygroundContextSettings = settings(),
  summary: PlaygroundContextSummary | null = null
) {
  const onSummaryChange = vi.fn()
  const hook = renderHook(() =>
    usePlaygroundContext({
      sessionId: 'pgs_1',
      messages,
      config: DEFAULT_CONFIG,
      systemPrompt: '',
      settings: contextSettings,
      summary,
      onSummaryChange,
    })
  )
  return { ...hook, onSummaryChange }
}

beforeEach(() => {
  vi.mocked(sendChatCompletion).mockReset()
})

test('automatic summary compresses the dropped messages before a send and persists the node', async () => {
  vi.mocked(sendChatCompletion).mockResolvedValue(
    completionResult('  A short summary.  ')
  )
  const { result, onSummaryChange } = mount()

  let returned: PlaygroundContextSummary | null = null
  await act(async () => {
    returned = await result.current.prepareForSend(messages)
  })

  expect(sendChatCompletion).toHaveBeenCalledTimes(1)
  const payload = vi.mocked(sendChatCompletion).mock.calls[0][0]
  expect(payload.stream).toBe(false)
  expect(payload.model).toBe('summary-model')
  expect(payload.messages).toContainEqual({ role: 'user', content: 'first' })
  expect(returned).toMatchObject({
    content: 'A short summary.',
    throughMessageKey: 'm1',
    messageCount: 1,
    model: 'summary-model',
    requestId: 'req-1',
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  })
  expect(onSummaryChange).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'A short summary.' })
  )
})

test('a send that fits the limits skips the summarization call', async () => {
  const { result, onSummaryChange } = mount(
    settings({ historyLimit: 0, tokenBudget: 0 })
  )

  let returned: PlaygroundContextSummary | null = null
  await act(async () => {
    returned = await result.current.prepareForSend(messages)
  })

  expect(sendChatCompletion).not.toHaveBeenCalled()
  expect(returned).toBeNull()
  expect(onSummaryChange).not.toHaveBeenCalled()
})

test('a failed summarization falls back to the current node without blocking the send', async () => {
  const previous: PlaygroundContextSummary = {
    id: 'pgc_previous',
    content: 'Previous summary.',
    throughMessageKey: 'm1',
    messageCount: 1,
    model: 'summary-model',
    createdAt: 1,
  }
  const history = [
    message('m1', 'first'),
    message('m2', 'second'),
    message('m3', 'third'),
    message('m4', 'fourth'),
  ]
  vi.mocked(sendChatCompletion).mockRejectedValue(new Error('relay down'))
  const onSummaryChange = vi.fn()
  const { result } = renderHook(() =>
    usePlaygroundContext({
      sessionId: 'pgs_1',
      messages: history,
      config: DEFAULT_CONFIG,
      systemPrompt: '',
      settings: settings({ historyLimit: 2 }),
      summary: previous,
      onSummaryChange,
    })
  )

  expect(result.current.plan.droppedMessages.map((item) => item.key)).toEqual([
    'm2',
  ])
  let returned: PlaygroundContextSummary | null = null
  await act(async () => {
    returned = await result.current.prepareForSend(history)
  })

  expect(sendChatCompletion).toHaveBeenCalledTimes(1)
  expect(returned).toBe(previous)
  expect(onSummaryChange).not.toHaveBeenCalled()
  expect(result.current.isSummarizing).toBe(false)
})

test('manual summarization uses the conversation model and reports the dropped messages', async () => {
  vi.mocked(sendChatCompletion).mockResolvedValue(
    completionResult('Compressed.')
  )
  const { result, onSummaryChange } = mount(
    settings({ autoSummarize: false, summaryModel: '' })
  )

  expect(result.current.plan.droppedMessages.map((item) => item.key)).toEqual([
    'm1',
  ])
  await act(async () => {
    await result.current.summarizeNow()
  })

  expect(sendChatCompletion).toHaveBeenCalledTimes(1)
  const payload = vi.mocked(sendChatCompletion).mock.calls[0][0]
  expect(payload.model).toBe(DEFAULT_CONFIG.model)
  expect(onSummaryChange).toHaveBeenCalledWith(
    expect.objectContaining({
      content: 'Compressed.',
      throughMessageKey: 'm1',
      model: DEFAULT_CONFIG.model,
    })
  )
})
