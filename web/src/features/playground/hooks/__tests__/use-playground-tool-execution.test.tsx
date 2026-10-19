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
import { render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { callPlaygroundMCPTool, searchPlaygroundWeb } from '../../api'
import { PLAYGROUND_TOOL_EXECUTION_ERRORS } from '../../constants'
import { searchKnowledgeBase } from '../../knowledge-api'
import { getMessageToolCalls } from '../../lib'
import type { PlaygroundMCPToolRef } from '../../lib/tools/mcp-tools'
import type { Message, MessageToolCall } from '../../types'
import {
  usePlaygroundToolExecution,
  type PlaygroundToolExecutionState,
} from '../use-playground-tool-execution'

vi.mock('../../api', () => ({
  callPlaygroundMCPTool: vi.fn(),
  searchPlaygroundWeb: vi.fn(),
}))
vi.mock('../../knowledge-api', () => ({ searchKnowledgeBase: vi.fn() }))

type HookOptions = Omit<
  Parameters<typeof usePlaygroundToolExecution>[0],
  'messages' | 'onUpdateMessages'
>

function toolCall(overrides: Partial<MessageToolCall> = {}): MessageToolCall {
  return {
    id: 'call_search',
    name: 'web_search',
    arguments: '{"query":"go"}',
    status: 'pending',
    ...overrides,
  }
}

function assistantMessage(
  toolCalls: MessageToolCall[],
  overrides: Partial<Message> = {}
): Message {
  return {
    key: 'assistant-1',
    from: 'assistant',
    status: 'complete',
    versions: [{ id: 'a1', content: '', toolCalls }],
    ...overrides,
  }
}

function userMessage(key = 'user-1'): Message {
  return {
    key,
    from: 'user',
    versions: [{ id: `${key}-v1`, content: 'question' }],
  }
}

function renderToolLoop(
  initialMessages: Message[],
  overrides: Partial<HookOptions> = {}
) {
  const onContinue = vi.fn()
  let latest: {
    messages: Message[]
    state: PlaygroundToolExecutionState
  } | null = null

  function Harness() {
    const [messages, setMessages] = useState(initialMessages)
    const state = usePlaygroundToolExecution({
      enabled: true,
      group: 'default',
      isBusy: false,
      knowledgeBaseIds: [],
      maxRounds: 5,
      onContinue,
      resultMaxBytes: 256 << 10,
      sessionId: 'session-1',
      ...overrides,
      messages,
      onUpdateMessages: (updater) =>
        setMessages((previous) =>
          typeof updater === 'function' ? updater(previous) : updater
        ),
    })
    latest = { messages, state }
    return null
  }

  const view = render(<Harness />)
  return {
    onContinue,
    view,
    getLatest: () => {
      if (!latest) throw new Error('harness did not render')
      return latest
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('a web search call is answered through the endpoint and continues once', async () => {
  vi.mocked(searchPlaygroundWeb).mockResolvedValue({
    query: 'go',
    provider: 'tavily',
    results: [{ title: 'Go', url: 'https://go.dev', snippet: 'Docs' }],
  })
  const { onContinue, getLatest } = renderToolLoop([
    userMessage(),
    assistantMessage([toolCall()]),
  ])

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe(
      'completed'
    )
  })
  expect(searchPlaygroundWeb).toHaveBeenCalledWith(
    'go',
    expect.any(AbortSignal)
  )
  expect(getMessageToolCalls(getLatest().messages[1])[0].result).toContain(
    'https://go.dev'
  )
  expect(
    getLatest().state.autoFilledKeys.has('assistant-1:a1:call_search')
  ).toBe(true)
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
})

test('a time call is generated in the browser without an endpoint', async () => {
  const { onContinue, getLatest } = renderToolLoop([
    userMessage(),
    assistantMessage([
      toolCall({
        name: 'get_time',
        arguments: '{"timezone":"UTC"}',
      }),
    ]),
  ])

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe(
      'completed'
    )
  })
  expect(searchPlaygroundWeb).not.toHaveBeenCalled()
  expect(getMessageToolCalls(getLatest().messages[1])[0].result).toContain(
    '"timezone":"UTC"'
  )
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
})

test('a knowledge search uses the bound base and records the merged hit', async () => {
  vi.mocked(searchKnowledgeBase).mockResolvedValue({
    hits: [
      {
        knowledgeBaseId: 'kb_1',
        knowledgeBaseName: 'Docs',
        documentId: 'doc_1',
        filename: 'guide.md',
        chunkId: 'chunk_1',
        chunkIndex: 0,
        score: 0.9,
        text: 'answer',
      },
    ],
    staleDocuments: [],
  })
  const { getLatest } = renderToolLoop(
    [
      userMessage(),
      assistantMessage([
        toolCall({
          name: 'kb_search',
          arguments: '{"query":"go","knowledge_base_id":"kb_1"}',
        }),
      ]),
    ],
    { group: 'vip', knowledgeBaseIds: ['kb_1'] }
  )

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe(
      'completed'
    )
  })
  expect(searchKnowledgeBase).toHaveBeenCalledWith(
    'kb_1',
    { query: 'go', topK: 6, group: 'vip' },
    expect.any(AbortSignal)
  )
  expect(getMessageToolCalls(getLatest().messages[1])[0].result).toContain(
    '"citation":1'
  )
})

test('a base outside the conversation binding becomes a stable error', async () => {
  const { onContinue, getLatest } = renderToolLoop(
    [
      userMessage(),
      assistantMessage([
        toolCall({
          name: 'kb_search',
          arguments: '{"query":"go","knowledge_base_id":"kb_other"}',
        }),
      ]),
    ],
    { knowledgeBaseIds: ['kb_1'] }
  )

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe('error')
  })
  expect(getMessageToolCalls(getLatest().messages[1])[0].errorMessage).toBe(
    PLAYGROUND_TOOL_EXECUTION_ERRORS.KB_NOT_SELECTED
  )
  expect(searchKnowledgeBase).not.toHaveBeenCalled()
  // An execution failure is still an automatic round, so the loop continues.
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
})

test('an MCP call is proxied with the catalog names and continues the loop', async () => {
  vi.mocked(callPlaygroundMCPTool).mockResolvedValue({
    isError: false,
    content: [{ type: 'text', text: 'pong' }],
  })
  const mcpTools: PlaygroundMCPToolRef[] = [
    {
      serverId: 'github',
      serverName: 'GitHub',
      toolName: 'ping',
      functionName: 'mcp__github__ping',
    },
  ]
  const { onContinue, getLatest } = renderToolLoop(
    [
      userMessage(),
      assistantMessage([
        toolCall({ name: 'mcp__github__ping', arguments: '{"repo":"a"}' }),
      ]),
    ],
    { mcpTools }
  )

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe(
      'completed'
    )
  })
  expect(callPlaygroundMCPTool).toHaveBeenCalledWith(
    'github',
    'ping',
    { repo: 'a' },
    expect.any(AbortSignal)
  )
  expect(getMessageToolCalls(getLatest().messages[1])[0].result).toContain(
    '"server":"GitHub"'
  )
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
})

test('an MCP call without a declared connection stays pending for the manual path', async () => {
  const { onContinue, getLatest } = renderToolLoop([
    userMessage(),
    assistantMessage([toolCall({ name: 'mcp__github__ping' })]),
  ])

  expect(callPlaygroundMCPTool).not.toHaveBeenCalled()
  expect(onContinue).not.toHaveBeenCalled()
  expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe('pending')
})

test('an unknown tool stays pending for the manual path and blocks the loop', async () => {
  const { onContinue, getLatest } = renderToolLoop([
    userMessage(),
    assistantMessage([toolCall({ name: 'open_page' })]),
  ])

  expect(searchPlaygroundWeb).not.toHaveBeenCalled()
  expect(onContinue).not.toHaveBeenCalled()
  expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe('pending')

  // A mixed reply answers the supported call but waits for the manual one.
  const mixed = renderToolLoop(
    [
      userMessage(),
      assistantMessage([
        toolCall(),
        toolCall({ id: 'call_other', name: 'open_page' }),
      ]),
    ],
    { knowledgeBaseIds: [] }
  )
  await waitFor(() => {
    expect(getMessageToolCalls(mixed.getLatest().messages[1])[0].status).toBe(
      'completed'
    )
  })
  expect(getMessageToolCalls(mixed.getLatest().messages[1])[1].status).toBe(
    'pending'
  )
  expect(mixed.onContinue).not.toHaveBeenCalled()
})

test('the loop stops at the round cap and leaves the manual continuation', async () => {
  const olderRound = assistantMessage(
    [toolCall({ id: 'call_older', status: 'completed', result: '{}' })],
    { key: 'assistant-0' }
  )
  const { onContinue, getLatest } = renderToolLoop(
    [
      userMessage(),
      olderRound,
      assistantMessage([toolCall({ id: 'call_current' })]),
    ],
    { maxRounds: 2 }
  )

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[2])[0].status).toBe(
      'completed'
    )
  })
  expect(onContinue).not.toHaveBeenCalled()
})

test('a disabled loop answers nothing', () => {
  const { onContinue, getLatest } = renderToolLoop(
    [userMessage(), assistantMessage([toolCall()])],
    { enabled: false }
  )

  expect(searchPlaygroundWeb).not.toHaveBeenCalled()
  expect(onContinue).not.toHaveBeenCalled()
  expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe('pending')
})

test('the stored result respects the server byte budget', async () => {
  vi.mocked(searchPlaygroundWeb).mockResolvedValue({
    query: 'go',
    provider: 'tavily',
    results: [
      { title: 'Go', url: 'https://go.dev', snippet: '中'.repeat(200) },
    ],
  })
  const { getLatest } = renderToolLoop(
    [userMessage(), assistantMessage([toolCall()])],
    { resultMaxBytes: 200 }
  )

  await waitFor(() => {
    expect(getMessageToolCalls(getLatest().messages[1])[0].status).toBe(
      'completed'
    )
  })
  const result = getMessageToolCalls(getLatest().messages[1])[0].result ?? ''
  expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(200)
})
