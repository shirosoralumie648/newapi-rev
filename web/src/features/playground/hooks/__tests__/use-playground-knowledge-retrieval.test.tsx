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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type {
  KnowledgeStaleDocument,
  Message,
  MessageKnowledgeResult,
  MessageKnowledgeSnapshot,
} from '../../types'
import { usePlaygroundKnowledgeRetrieval } from '../use-playground-knowledge-retrieval'

const mocks = vi.hoisted(() => ({
  searchKnowledgeBase: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../../knowledge-api', () => ({
  searchKnowledgeBase: mocks.searchKnowledgeBase,
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

function userMessage(
  content: string,
  knowledge?: MessageKnowledgeSnapshot
): Message {
  return {
    key: `user-${content}`,
    from: 'user',
    versions: [{ id: `version-${content}`, content }],
    ...(knowledge ? { knowledge } : {}),
  }
}

function hit(
  overrides: Partial<MessageKnowledgeResult> = {}
): MessageKnowledgeResult {
  return {
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: 'Handbook',
    documentId: 'doc-1',
    filename: 'handbook.txt',
    chunkId: 'chunk-1',
    chunkIndex: 0,
    score: 0.5,
    text: 'source text',
    ...overrides,
  }
}

function stale(
  overrides: Partial<KnowledgeStaleDocument> = {}
): KnowledgeStaleDocument {
  return {
    id: 'doc-stale',
    filename: 'stale.txt',
    embeddingModel: 'embed-old',
    ...overrides,
  }
}

beforeEach(() => {
  mocks.searchKnowledgeBase.mockReset()
  mocks.toastError.mockReset()
})

describe('usePlaygroundKnowledgeRetrieval', () => {
  test('queries every bound base and stores the merged snapshot on the last user turn', async () => {
    const signal = new AbortController().signal
    mocks.searchKnowledgeBase.mockImplementation((knowledgeBaseId: string) => {
      if (knowledgeBaseId === 'kb-1') {
        return Promise.resolve({
          hits: [hit({ chunkId: 'shared', score: 0.4, text: 'first copy' })],
          staleDocuments: [stale({ id: 'doc-z', filename: 'z.txt' })],
        })
      }
      return Promise.resolve({
        hits: [
          hit({
            chunkId: 'fresh',
            filename: 'fresh.txt',
            score: 0.9,
            text: 'fresh source',
          }),
          hit({ chunkId: 'shared', score: 0.8, text: 'second copy' }),
        ],
        staleDocuments: [stale({ id: 'doc-a', filename: 'a.txt' })],
      })
    })
    const messages: Message[] = [
      userMessage('Earlier question'),
      {
        key: 'assistant-1',
        from: 'assistant',
        versions: [{ id: 'assistant-v1', content: 'Earlier answer' }],
      },
      userMessage('  What changed?  '),
    ]
    const { result } = renderHook(() => usePlaygroundKnowledgeRetrieval())

    let returned: Message[] = []
    await act(async () => {
      returned = await result.current.retrieve(
        messages,
        ['kb-1', 'kb-2'],
        'vip',
        signal
      )
    })

    expect(mocks.searchKnowledgeBase).toHaveBeenNthCalledWith(
      1,
      'kb-1',
      { query: 'What changed?', topK: 6, group: 'vip' },
      signal
    )
    expect(mocks.searchKnowledgeBase).toHaveBeenNthCalledWith(
      2,
      'kb-2',
      { query: 'What changed?', topK: 6, group: 'vip' },
      signal
    )
    expect(returned[2].knowledge).toEqual({
      query: 'What changed?',
      results: [
        hit({
          chunkId: 'fresh',
          filename: 'fresh.txt',
          score: 0.9,
          text: 'fresh source',
        }),
        hit({ chunkId: 'shared', score: 0.4, text: 'first copy' }),
      ],
    })
    expect(messages[2].knowledge).toBeUndefined()
    expect(returned[0]).toBe(messages[0])
    expect(returned[1]).toBe(messages[1])
    expect(result.current.diagnostics).toMatchObject({
      staleDocuments: [
        stale({ id: 'doc-a', filename: 'a.txt' }),
        stale({ id: 'doc-z', filename: 'z.txt' }),
      ],
      resultCount: 2,
    })
    expect(result.current.isRetrieving).toBe(false)
  })

  test('reuses a matching stored snapshot without another query', async () => {
    const knowledge: MessageKnowledgeSnapshot = {
      query: 'What changed?',
      results: [hit()],
    }
    const messages = [userMessage('What changed?', knowledge)]
    const { result } = renderHook(() => usePlaygroundKnowledgeRetrieval())

    let returned: Message[] = []
    await act(async () => {
      returned = await result.current.retrieve(messages, ['kb-1'], 'vip')
    })

    expect(returned).toBe(messages)
    expect(mocks.searchKnowledgeBase).not.toHaveBeenCalled()
  })

  test('reports a failed retrieval and sends the turn without knowledge context', async () => {
    mocks.searchKnowledgeBase.mockRejectedValue({
      message_key: 'The embedding request failed.',
    })
    const messages = [userMessage('What changed?')]
    const { result } = renderHook(() => usePlaygroundKnowledgeRetrieval())

    let returned: Message[] = []
    await act(async () => {
      returned = await result.current.retrieve(messages, ['kb-1'], 'vip')
    })

    expect(returned).toBe(messages)
    expect(mocks.toastError).toHaveBeenCalledWith(
      'The embedding request failed.'
    )
    expect(result.current.diagnostics).toBeNull()
    expect(result.current.isRetrieving).toBe(false)
  })

  test('does not query when the only bound base belongs to no user turn', async () => {
    const messages: Message[] = [
      {
        key: 'assistant-only',
        from: 'assistant',
        versions: [{ id: 'v1', content: 'Hello' }],
      },
    ]
    const { result } = renderHook(() => usePlaygroundKnowledgeRetrieval())

    await act(async () => {
      await result.current.retrieve(messages, ['kb-1'], 'vip')
    })

    expect(mocks.searchKnowledgeBase).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
