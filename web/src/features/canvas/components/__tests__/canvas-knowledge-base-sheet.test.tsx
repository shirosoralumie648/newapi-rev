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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type {
  KnowledgeBase,
  KnowledgeDocument,
} from '@/features/playground/knowledge-api'
import en from '@/i18n/locales/en.json'

import { CanvasKnowledgeBaseSheet } from '../canvas-knowledge-base-sheet'

const knowledgeApi = vi.hoisted(() => ({
  createKnowledgeBase: vi.fn(),
  createKnowledgeClientKey: vi.fn((prefix: string) => `${prefix}-client-key`),
  createKnowledgeDocument: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  getKnowledgeDocument: vi.fn(),
  indexKnowledgeDocument: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  reindexKnowledgeDocument: vi.fn(),
}))

vi.mock('@/features/playground/knowledge-api', () => knowledgeApi)

vi.mock('@/features/playground/api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/playground/api')>()
  return {
    ...actual,
    getUserGroups: vi.fn(async () => [
      { label: 'Default', value: 'default', ratio: 1 },
    ]),
  }
})

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const base: KnowledgeBase = {
  id: 'kb-1',
  name: 'Handbook',
  embeddingModel: 'text-embedding-3-small',
  documentCount: 3,
  chunkCount: 6,
  byteSize: 2048,
  createdAt: 1,
  updatedAt: 1,
}

const document: KnowledgeDocument = {
  id: 'doc-1',
  knowledgeBaseId: 'kb-1',
  filename: 'handbook.txt',
  mediaType: 'text/plain',
  byteSize: 10,
  textBytes: 10,
  pageCount: 0,
  status: 'failed',
  errorMessage: 'provider unavailable',
  embeddingModel: '',
  embeddingDims: 0,
  chunkCount: 0,
  createdAt: 1,
  updatedAt: 1,
}

let bases: KnowledgeBase[] = []
let documents: KnowledgeDocument[] = []
let testI18n: i18n

function renderSheet() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <CanvasKnowledgeBaseSheet
          onOpenChange={() => undefined}
          open
          userId={7}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

beforeEach(async () => {
  bases = []
  documents = []
  vi.clearAllMocks()
  knowledgeApi.listKnowledgeBases.mockImplementation(async () => bases)
  knowledgeApi.listKnowledgeDocuments.mockImplementation(async () => documents)
  knowledgeApi.createKnowledgeClientKey.mockImplementation(
    (prefix: string) => `${prefix}-client-key`
  )
  knowledgeApi.indexKnowledgeDocument.mockResolvedValue(undefined)
  knowledgeApi.deleteKnowledgeBase.mockResolvedValue(undefined)
  knowledgeApi.deleteKnowledgeDocument.mockResolvedValue(undefined)
  knowledgeApi.createKnowledgeBase.mockImplementation(
    async (input: { name: string; embeddingModel: string }) => {
      const created = {
        ...base,
        name: input.name,
        embeddingModel: input.embeddingModel,
      }
      bases = [...bases, created]
      return created
    }
  )
  knowledgeApi.createKnowledgeDocument.mockResolvedValue({
    ...document,
    status: 'pending',
    errorMessage: '',
    text: 'alpha text',
  })
  knowledgeApi.reindexKnowledgeDocument.mockResolvedValue({
    ...document,
    status: 'pending',
    errorMessage: '',
    text: 'retry text',
  })

  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

describe('CanvasKnowledgeBaseSheet', () => {
  test('creating a knowledge base submits the name and embedding model idempotently', async () => {
    const user = userEvent.setup()
    renderSheet()

    expect(await screen.findByText('No knowledge bases yet')).toBeVisible()
    await user.type(screen.getByLabelText('Knowledge base name'), 'Handbook')
    const model = screen.getByLabelText('Embedding model')
    await user.clear(model)
    await user.type(model, 'text-embedding-3-large')
    await user.click(
      screen.getByRole('button', { name: 'Create knowledge base' })
    )

    await waitFor(() =>
      expect(knowledgeApi.createKnowledgeBase).toHaveBeenCalledWith({
        name: 'Handbook',
        embeddingModel: 'text-embedding-3-large',
        clientKey: 'pgkb-client-key',
      })
    )
  })

  test('uploading a document stores its bytes and indexes the extracted text', async () => {
    bases = [base]
    renderSheet()

    expect(
      await screen.findByText('3 documents · 6 chunks · 2 KiB')
    ).toBeVisible()
    const file = new File(['alpha text'], 'handbook.txt', {
      type: 'text/plain',
    })
    fireEvent.change(screen.getByLabelText('Upload knowledge base document'), {
      target: { files: [file] },
    })

    await waitFor(() =>
      expect(knowledgeApi.createKnowledgeDocument).toHaveBeenCalledWith(
        'kb-1',
        expect.objectContaining({
          filename: 'handbook.txt',
          mediaType: 'text/plain',
          clientKey: 'pgkd-client-key',
        })
      )
    )
    await waitFor(() =>
      expect(knowledgeApi.indexKnowledgeDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseId: 'kb-1',
          documentId: 'doc-1',
          embeddingModel: 'text-embedding-3-small',
          text: 'alpha text',
          group: 'default',
        })
      )
    )
  })

  test('uploading a markdown document normalizes an empty browser media type', async () => {
    bases = [base]
    renderSheet()

    expect(
      await screen.findByText('3 documents · 6 chunks · 2 KiB')
    ).toBeVisible()
    const file = new File(['# alpha text'], 'handbook.md', { type: '' })
    fireEvent.change(screen.getByLabelText('Upload knowledge base document'), {
      target: { files: [file] },
    })

    await waitFor(() =>
      expect(knowledgeApi.createKnowledgeDocument).toHaveBeenCalledWith(
        'kb-1',
        expect.objectContaining({
          filename: 'handbook.md',
          mediaType: 'text/markdown',
        })
      )
    )
    await waitFor(() =>
      expect(knowledgeApi.indexKnowledgeDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'doc-1' })
      )
    )
  })

  test('rebuilding an index clears the old chunks before embedding again', async () => {
    bases = [base]
    documents = [document]
    const user = userEvent.setup()
    renderSheet()

    expect(await screen.findByText('handbook.txt')).toBeVisible()
    expect(screen.getByText('provider unavailable')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Rebuild index' }))

    await waitFor(() =>
      expect(knowledgeApi.reindexKnowledgeDocument).toHaveBeenCalledWith(
        'kb-1',
        'doc-1'
      )
    )
    await waitFor(() =>
      expect(knowledgeApi.indexKnowledgeDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'doc-1', text: 'retry text' })
      )
    )
  })

  test('marks a ready document as needing rebuild after the base model changes', async () => {
    bases = [base]
    documents = [
      {
        ...document,
        status: 'ready',
        errorMessage: '',
        embeddingModel: 'text-embedding-3-large',
        embeddingDims: 2,
        chunkCount: 2,
      },
    ]
    renderSheet()

    expect(await screen.findByText('handbook.txt')).toBeVisible()
    expect(screen.getByText('Needs rebuild')).toBeVisible()
  })

  test('deleting a knowledge base requires confirmation', async () => {
    bases = [base]
    const user = userEvent.setup()
    renderSheet()

    expect(await screen.findByText('Handbook')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Delete Handbook' }))
    expect(screen.getByText('Delete knowledge base?')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() =>
      expect(knowledgeApi.deleteKnowledgeBase).toHaveBeenCalledWith('kb-1')
    )
  })
})
