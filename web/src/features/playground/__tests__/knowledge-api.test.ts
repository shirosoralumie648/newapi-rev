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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  indexKnowledgeDocument,
  requestKnowledgeEmbeddings,
  searchKnowledgeBase,
} from '../knowledge-api'

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: apiMock }))

function documentResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    knowledge_base_id: 'kb-1',
    filename: 'handbook.txt',
    media_type: 'text/plain',
    byte_size: 1024,
    text_bytes: 1024,
    page_count: 0,
    status: 'ready',
    error_message: '',
    embedding_model: 'text-embedding-3-small',
    embedding_dims: 2,
    chunk_count: 0,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('requestKnowledgeEmbeddings', () => {
  test('restores provider order and forwards the selected group', async () => {
    apiMock.post.mockResolvedValue({
      data: {
        success: true,
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      },
    })

    const vectors = await requestKnowledgeEmbeddings({
      model: 'text-embedding-3-small',
      texts: ['alpha', 'beta'],
      group: 'vip',
    })

    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(apiMock.post).toHaveBeenCalledWith(
      '/pg/embeddings',
      { model: 'text-embedding-3-small', input: ['alpha', 'beta'] },
      expect.objectContaining({
        skipErrorHandler: true,
        headers: { 'X-Playground-Group': 'vip' },
      })
    )
  })
})

describe('searchKnowledgeBase', () => {
  test('sends the ranked request and maps hits plus stale documents', async () => {
    const signal = new AbortController().signal
    apiMock.post.mockResolvedValue({
      data: {
        success: true,
        data: {
          knowledge_base: { id: 'kb-1', name: 'Handbook' },
          hits: [
            {
              knowledge_base_id: 'kb-1',
              knowledge_base_name: 'Handbook',
              document_id: 'doc-1',
              filename: 'handbook.txt',
              chunk_id: 'chunk-1',
              chunk_index: 0,
              score: 0.875,
              text: 'Alpha paragraph.',
              truncated: true,
            },
          ],
          stale_documents: [
            {
              id: 'doc-2',
              filename: 'legacy.txt',
              embedding_model: 'embed-old',
            },
          ],
        },
      },
    })

    const result = await searchKnowledgeBase(
      'kb-1',
      { query: 'release notes', topK: 6, group: 'vip' },
      signal
    )

    expect(apiMock.post).toHaveBeenCalledWith(
      '/api/playground/knowledge-bases/kb-1/search',
      { query: 'release notes', top_k: 6, group: 'vip' },
      { signal }
    )
    expect(result).toEqual({
      hits: [
        {
          knowledgeBaseId: 'kb-1',
          knowledgeBaseName: 'Handbook',
          documentId: 'doc-1',
          filename: 'handbook.txt',
          chunkId: 'chunk-1',
          chunkIndex: 0,
          score: 0.875,
          text: 'Alpha paragraph.',
          truncated: true,
        },
      ],
      staleDocuments: [
        {
          id: 'doc-2',
          filename: 'legacy.txt',
          embeddingModel: 'embed-old',
        },
      ],
    })
  })
})

describe('indexKnowledgeDocument', () => {
  test('batches embeddings and stores the complete chunk set', async () => {
    apiMock.post.mockImplementation(
      (url: string, body: { input?: string[] }) => {
        if (url !== '/pg/embeddings') {
          return Promise.resolve({ data: { success: true, data: {} } })
        }
        const input = body.input ?? []
        return Promise.resolve({
          data: {
            success: true,
            data: input.map((_, index) => ({
              index,
              embedding: [index + 1, 0.5],
            })),
          },
        })
      }
    )
    apiMock.put.mockImplementation(
      (
        _url: string,
        body: {
          chunks: { embedding: string }[]
          dims: number
          embedding_model: string
        }
      ) =>
        Promise.resolve({
          data: {
            success: true,
            data: documentResponse({
              chunk_count: body.chunks.length,
              embedding_dims: body.dims,
              embedding_model: body.embedding_model,
            }),
          },
        })
    )
    const progress: Array<[number, number]> = []

    await indexKnowledgeDocument({
      knowledgeBaseId: 'kb-1',
      documentId: 'doc-1',
      embeddingModel: 'text-embedding-3-small',
      text: 'alpha '.repeat(5632),
      group: 'vip',
      onProgress: (completed, total) => progress.push([completed, total]),
    })

    const embeddingBodies = apiMock.post.mock.calls
      .filter(([url]) => url === '/pg/embeddings')
      .map(([, body]) => body as { input: string[] })
    expect(embeddingBodies).toHaveLength(2)
    expect(embeddingBodies[0].input).toHaveLength(32)
    expect(embeddingBodies[1].input.length).toBeGreaterThan(0)
    expect(embeddingBodies[1].input.length).toBeLessThanOrEqual(32)

    const [url, rawPayload] = apiMock.put.mock.calls[0]
    const payload = rawPayload as {
      chunks: { embedding: string }[]
      dims: number
      embedding_model: string
    }
    expect(url).toBe(
      '/api/playground/knowledge-bases/kb-1/documents/doc-1/chunks'
    )
    expect(payload.embedding_model).toBe('text-embedding-3-small')
    expect(payload.dims).toBe(2)
    expect(payload.chunks).toHaveLength(progress.at(-1)?.[1] ?? 0)
    const vector = Uint8Array.from(atob(payload.chunks[0].embedding), (char) =>
      char.charCodeAt(0)
    )
    expect(vector).toHaveLength(8)
    expect(new DataView(vector.buffer).getFloat32(0, true)).toBeCloseTo(1)
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1])
  })

  test('reports a failed embedding run so the document can be retried', async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/pg/embeddings') {
        return Promise.reject(new Error('relay down'))
      }
      return Promise.resolve({ data: { success: true, data: {} } })
    })

    await expect(
      indexKnowledgeDocument({
        knowledgeBaseId: 'kb-1',
        documentId: 'doc-1',
        embeddingModel: 'text-embedding-3-small',
        text: 'alpha text',
      })
    ).rejects.toThrow('relay down')

    const failure = apiMock.post.mock.calls.find(([url]) =>
      url.endsWith('/failure')
    )
    expect(failure?.[1]).toEqual({
      message: 'Knowledge indexing failed in the browser.',
    })
  })
})
