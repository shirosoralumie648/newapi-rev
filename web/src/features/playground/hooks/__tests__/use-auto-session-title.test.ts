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

import { sendChatCompletion } from '../../api'
import type { ChatCompletionResponse, Message } from '../../types'
import { useAutoSessionTitle } from '../use-auto-session-title'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, sendChatCompletion: vi.fn() }
})

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
    versions: [{ id: 'a1-v1', content: 'Visit the food market first.' }],
  },
]

function titleResponse(content: string): ChatCompletionResponse {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'summary-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  }
}

type AutoTitleOptions = Parameters<typeof useAutoSessionTitle>[0]

function options(overrides: Partial<AutoTitleOptions> = {}): AutoTitleOptions {
  return {
    enabled: true,
    sessionId: 'local-1',
    sessionTitle: 'New conversation',
    messages,
    model: 'summary-model',
    group: 'default',
    isBusy: true,
    onRename: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('names the conversation once the first completed reply is no longer busy', async () => {
  vi.mocked(sendChatCompletion).mockResolvedValue({
    response: titleResponse('"Kyoto Food Itinerary"'),
  })
  const initial = options()
  const hook = renderHook(
    (props: AutoTitleOptions) => useAutoSessionTitle(props),
    { initialProps: initial }
  )

  await act(async () => {
    hook.rerender({ ...initial, isBusy: false })
  })

  await waitFor(() =>
    expect(initial.onRename).toHaveBeenCalledWith(
      'local-1',
      'Kyoto Food Itinerary'
    )
  )
  expect(sendChatCompletion).toHaveBeenCalledTimes(1)
  expect(vi.mocked(sendChatCompletion).mock.calls[0][0]).toMatchObject({
    model: 'summary-model',
    group: 'default',
    stream: false,
  })
})

test('does not name a disabled conversation or replace a custom title', async () => {
  const disabled = options({ enabled: false })
  const disabledHook = renderHook(
    (props: AutoTitleOptions) => useAutoSessionTitle(props),
    { initialProps: disabled }
  )
  await act(async () => {
    disabledHook.rerender({ ...disabled, isBusy: false })
  })

  const renamed = options({ sessionTitle: 'My own title' })
  const renamedHook = renderHook(
    (props: AutoTitleOptions) => useAutoSessionTitle(props),
    { initialProps: renamed }
  )
  await act(async () => {
    renamedHook.rerender({ ...renamed, isBusy: false })
  })

  expect(sendChatCompletion).not.toHaveBeenCalled()
  expect(disabled.onRename).not.toHaveBeenCalled()
  expect(renamed.onRename).not.toHaveBeenCalled()
})

test('keeps the old title on an empty answer and retries on a later reply', async () => {
  vi.mocked(sendChatCompletion).mockResolvedValue({
    response: titleResponse('  '),
  })
  const initial = options()
  const hook = renderHook(
    (props: AutoTitleOptions) => useAutoSessionTitle(props),
    { initialProps: initial }
  )

  await act(async () => {
    hook.rerender({ ...initial, isBusy: false })
  })
  await waitFor(() => expect(sendChatCompletion).toHaveBeenCalledTimes(1))
  expect(initial.onRename).not.toHaveBeenCalled()

  vi.mocked(sendChatCompletion).mockResolvedValue({
    response: titleResponse('Kyoto in three days'),
  })
  await act(async () => {
    hook.rerender({ ...initial, isBusy: true })
  })
  await act(async () => {
    hook.rerender({ ...initial, isBusy: false })
  })

  await waitFor(() =>
    expect(initial.onRename).toHaveBeenCalledWith(
      'local-1',
      'Kyoto in three days'
    )
  )
})

test('a conversation switch discards the late title request', async () => {
  let resolve!: (value: { response: ChatCompletionResponse }) => void
  vi.mocked(sendChatCompletion).mockReturnValue(
    new Promise<{ response: ChatCompletionResponse }>((done) => {
      resolve = done
    })
  )
  const initial = options()
  const hook = renderHook(
    (props: AutoTitleOptions) => useAutoSessionTitle(props),
    { initialProps: initial }
  )

  await act(async () => {
    hook.rerender({ ...initial, isBusy: false })
  })
  await waitFor(() => expect(sendChatCompletion).toHaveBeenCalledTimes(1))

  await act(async () => {
    hook.rerender({
      ...initial,
      sessionId: 'local-2',
      onRename: vi.fn(),
      isBusy: false,
    })
  })
  await act(async () => {
    resolve({ response: titleResponse('Kyoto Food Itinerary') })
  })

  expect(initial.onRename).not.toHaveBeenCalled()
})

test('a manual rename during the request is preserved', async () => {
  let resolve!: (value: { response: ChatCompletionResponse }) => void
  vi.mocked(sendChatCompletion).mockReturnValue(
    new Promise<{ response: ChatCompletionResponse }>((done) => {
      resolve = done
    })
  )
  const initial = options()
  const hook = renderHook(
    (props: AutoTitleOptions) => useAutoSessionTitle(props),
    { initialProps: initial }
  )

  await act(async () => {
    hook.rerender({ ...initial, isBusy: false })
  })
  await waitFor(() => expect(sendChatCompletion).toHaveBeenCalledTimes(1))

  await act(async () => {
    hook.rerender({
      ...initial,
      sessionTitle: 'My own title',
      isBusy: false,
    })
  })
  await act(async () => {
    resolve({ response: titleResponse('Kyoto Food Itinerary') })
  })

  expect(initial.onRename).not.toHaveBeenCalled()
})
