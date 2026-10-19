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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { sendChatCompletion } from '../../api'
import { DEFAULT_CONFIG, DEFAULT_CONTEXT_SETTINGS } from '../../constants'
import { playgroundQueryKeys } from '../../lib/query-keys'
import type {
  ChatCompletionResponse,
  Message,
  PlaygroundMemory,
} from '../../types'
import { usePlaygroundMemoryExtraction } from '../use-playground-memories'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, sendChatCompletion: vi.fn() }
})

const storedMemory: PlaygroundMemory = {
  id: 'pgm_1',
  content: 'Prefers concise answers.',
  category: 'preference',
  sourceSessionId: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}

const messages: Message[] = [
  {
    key: 'u1',
    from: 'user',
    versions: [{ id: 'u1-v1', content: 'I prefer concise answers.' }],
  },
  {
    key: 'a1',
    from: 'assistant',
    status: 'complete',
    versions: [{ id: 'a1-v1', content: 'Understood.' }],
  },
]

function extractionResponse(content: string): ChatCompletionResponse {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'memory-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  }
}

type ExtractionOptions = Parameters<typeof usePlaygroundMemoryExtraction>[0]

function options(
  overrides: Partial<ExtractionOptions> = {}
): ExtractionOptions {
  return {
    userId: 7,
    config: DEFAULT_CONFIG,
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    settings: { enabled: true, model: 'memory-model' },
    messages,
    sourceSessionId: 'pgs_1',
    isBusy: true,
    ...overrides,
  }
}

let queryClient: QueryClient
let wrapper: (props: { children: ReactNode }) => ReactElement

beforeEach(() => {
  vi.clearAllMocks()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(playgroundQueryKeys.memories(7), {
    items: [storedMemory],
    total: 1,
    limit: 100,
  })
  wrapper = (props) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  )
})

test('a completed reply runs one billed non-streaming extraction and stores the candidate', async () => {
  vi.mocked(sendChatCompletion).mockResolvedValue({
    response: extractionResponse(
      '{"memories":[{"content":"Uses TypeScript daily.","category":"general"}]}'
    ),
    requestId: 'req-extract',
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        id: 'pgm_2',
        content: 'Uses TypeScript daily.',
        category: 'general',
        source_session_id: 'pgs_1',
        enabled: true,
        created_at: 2,
        updated_at: 2,
      },
    },
  })

  const hook = renderHook(
    (props: ReturnType<typeof options>) => usePlaygroundMemoryExtraction(props),
    { wrapper, initialProps: options() }
  )
  await act(async () => {
    hook.rerender(options({ isBusy: false }))
  })

  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(sendChatCompletion).toHaveBeenCalledTimes(1)
  const payload = vi.mocked(sendChatCompletion).mock.calls[0][0]
  expect(payload).toMatchObject({
    model: 'memory-model',
    group: DEFAULT_CONFIG.group,
    stream: false,
  })
  expect(
    payload.messages.some(
      (message) =>
        message.role === 'assistant' || message.content === 'Understood.'
    )
  ).toBe(false)
  expect(post).toHaveBeenCalledWith(
    '/api/playground/memories',
    {
      content: 'Uses TypeScript daily.',
      category: 'general',
      source_session_id: 'pgs_1',
    },
    expect.anything()
  )
})

test('the default-off switch prevents any extraction request', async () => {
  const hook = renderHook(
    (props: ReturnType<typeof options>) => usePlaygroundMemoryExtraction(props),
    {
      wrapper,
      initialProps: options({ settings: { enabled: false, model: '' } }),
    }
  )
  await act(async () => {
    hook.rerender(
      options({ settings: { enabled: false, model: '' }, isBusy: false })
    )
  })

  expect(sendChatCompletion).not.toHaveBeenCalled()
})
