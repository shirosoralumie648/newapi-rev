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
import { z } from 'zod'

import { api } from '@/lib/api'
import {
  getServerMessage,
  requireServerSuccess,
} from '@/lib/server-error-message'

import { API_ENDPOINTS } from './constants'
import {
  chunkKnowledgeText,
  type KnowledgeChunk,
} from './lib/knowledge/chunker'
import {
  bytesToBase64,
  encodeKnowledgeEmbedding,
} from './lib/knowledge/embedding'

/** How many chunks one embedding relay request carries. */
const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 32
/** Mirrors the built-in server ceiling; the server remains authoritative. */
const KNOWLEDGE_EMBEDDING_MAX_DIMS = 4096

export type KnowledgeDocumentStatus = 'pending' | 'ready' | 'failed'

export interface KnowledgeBase {
  id: string
  name: string
  embeddingModel: string
  documentCount: number
  chunkCount: number
  byteSize: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeDocument {
  id: string
  knowledgeBaseId: string
  filename: string
  mediaType: string
  byteSize: number
  textBytes: number
  pageCount: number
  status: KnowledgeDocumentStatus
  errorMessage: string
  embeddingModel: string
  embeddingDims: number
  chunkCount: number
  createdAt: number
  updatedAt: number
  /** Extracted text; present on create, detail and reindex responses. */
  text?: string
}

export interface KnowledgeBaseInput {
  name: string
  embeddingModel: string
  clientKey: string
}

export interface KnowledgeDocumentInput {
  filename: string
  mediaType: string
  data: ArrayBuffer
  clientKey: string
}

export interface KnowledgeChunkInput {
  index: number
  text: string
  embedding: string
}

export interface KnowledgeChunksPayload {
  embeddingModel: string
  dims: number
  chunks: KnowledgeChunkInput[]
}

const knowledgeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  embedding_model: z.string(),
  document_count: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const knowledgeDocumentSchema = z.object({
  id: z.string().min(1),
  knowledge_base_id: z.string().min(1),
  filename: z.string(),
  media_type: z.string(),
  byte_size: z.number().int().nonnegative(),
  text_bytes: z.number().int().nonnegative(),
  page_count: z.number().int().nonnegative(),
  status: z.enum(['pending', 'ready', 'failed']),
  error_message: z.string(),
  embedding_model: z.string(),
  embedding_dims: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  text: z.string().optional(),
})

const knowledgeBaseListingSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().nonnegative(),
})

const knowledgeDocumentListingSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().nonnegative(),
})

const knowledgeBaseCreatedSchema = z.object({
  created: z.boolean(),
  knowledge_base: z.unknown(),
})

const knowledgeDocumentCreatedSchema = z.object({
  created: z.boolean(),
  document: z.unknown(),
})

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    })
  ),
})

function mapKnowledgeBase(value: unknown): KnowledgeBase {
  const base = knowledgeBaseSchema.parse(value)
  return {
    id: base.id,
    name: base.name,
    embeddingModel: base.embedding_model,
    documentCount: base.document_count,
    chunkCount: base.chunk_count,
    byteSize: base.byte_size,
    createdAt: base.created_at,
    updatedAt: base.updated_at,
  }
}

function mapKnowledgeDocument(value: unknown): KnowledgeDocument {
  const document = knowledgeDocumentSchema.parse(value)
  return {
    id: document.id,
    knowledgeBaseId: document.knowledge_base_id,
    filename: document.filename,
    mediaType: document.media_type,
    byteSize: document.byte_size,
    textBytes: document.text_bytes,
    pageCount: document.page_count,
    status: document.status,
    errorMessage: document.error_message,
    embeddingModel: document.embedding_model,
    embeddingDims: document.embedding_dims,
    chunkCount: document.chunk_count,
    createdAt: document.created_at,
    updatedAt: document.updated_at,
    ...(document.text === undefined ? {} : { text: document.text }),
  }
}

function knowledgeDocumentPath(knowledgeBaseId: string, documentId?: string) {
  const base = `${API_ENDPOINTS.PLAYGROUND_KNOWLEDGE_BASES}/${encodeURIComponent(knowledgeBaseId)}/documents`
  return documentId === undefined
    ? base
    : `${base}/${encodeURIComponent(documentId)}`
}

export function createKnowledgeClientKey(prefix: string): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`
}

export async function listKnowledgeBases(
  signal?: AbortSignal
): Promise<KnowledgeBase[]> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_KNOWLEDGE_BASES, {
    signal,
  })
  requireServerSuccess(response.data)
  const data = knowledgeBaseListingSchema.parse(response.data.data)
  return data.items.map(mapKnowledgeBase)
}

export async function createKnowledgeBase(
  input: KnowledgeBaseInput,
  signal?: AbortSignal
): Promise<KnowledgeBase> {
  const response = await api.post(
    API_ENDPOINTS.PLAYGROUND_KNOWLEDGE_BASES,
    {
      client_key: input.clientKey,
      name: input.name,
      embedding_model: input.embeddingModel,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  const data = knowledgeBaseCreatedSchema.parse(response.data.data)
  return mapKnowledgeBase(data.knowledge_base)
}

export async function deleteKnowledgeBase(
  knowledgeBaseId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_KNOWLEDGE_BASES}/${encodeURIComponent(knowledgeBaseId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}

export async function listKnowledgeDocuments(
  knowledgeBaseId: string,
  signal?: AbortSignal
): Promise<KnowledgeDocument[]> {
  const response = await api.get(knowledgeDocumentPath(knowledgeBaseId), {
    signal,
  })
  requireServerSuccess(response.data)
  const data = knowledgeDocumentListingSchema.parse(response.data.data)
  return data.items.map(mapKnowledgeDocument)
}

export async function getKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<KnowledgeDocument> {
  const response = await api.get(
    knowledgeDocumentPath(knowledgeBaseId, documentId),
    { signal }
  )
  requireServerSuccess(response.data)
  return mapKnowledgeDocument(response.data.data)
}

export async function createKnowledgeDocument(
  knowledgeBaseId: string,
  input: KnowledgeDocumentInput,
  signal?: AbortSignal
): Promise<KnowledgeDocument> {
  const response = await api.post(
    knowledgeDocumentPath(knowledgeBaseId),
    {
      client_key: input.clientKey,
      filename: input.filename,
      media_type: input.mediaType,
      data: bytesToBase64(new Uint8Array(input.data)),
    },
    { signal }
  )
  requireServerSuccess(response.data)
  const data = knowledgeDocumentCreatedSchema.parse(response.data.data)
  return mapKnowledgeDocument(data.document)
}

export async function deleteKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    knowledgeDocumentPath(knowledgeBaseId, documentId),
    { signal }
  )
  requireServerSuccess(response.data)
}

export async function reindexKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  signal?: AbortSignal
): Promise<KnowledgeDocument> {
  const response = await api.post(
    `${knowledgeDocumentPath(knowledgeBaseId, documentId)}/reindex`,
    undefined,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapKnowledgeDocument(response.data.data)
}

export async function failKnowledgeDocument(
  knowledgeBaseId: string,
  documentId: string,
  message: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.post(
    `${knowledgeDocumentPath(knowledgeBaseId, documentId)}/failure`,
    { message: message.slice(0, 500) },
    { signal }
  )
  requireServerSuccess(response.data)
}

export async function replaceKnowledgeDocumentChunks(
  knowledgeBaseId: string,
  documentId: string,
  payload: KnowledgeChunksPayload,
  signal?: AbortSignal
): Promise<KnowledgeDocument> {
  const response = await api.put(
    `${knowledgeDocumentPath(knowledgeBaseId, documentId)}/chunks`,
    {
      embedding_model: payload.embeddingModel,
      dims: payload.dims,
      chunks: payload.chunks,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapKnowledgeDocument(response.data.data)
}

/**
 * Compute embeddings through the workspace relay. The group header is consumed
 * by the server before the canonical /v1/embeddings request, so channel
 * selection, group permissions and billing are the same as a direct call.
 */
export async function requestKnowledgeEmbeddings(input: {
  model: string
  texts: string[]
  group?: string
  signal?: AbortSignal
}): Promise<number[][]> {
  const response = await api.post(
    API_ENDPOINTS.EMBEDDINGS,
    { model: input.model, input: input.texts },
    {
      signal: input.signal,
      skipErrorHandler: true,
      ...(input.group
        ? { headers: { 'X-Playground-Group': input.group } }
        : {}),
    }
  )
  requireServerSuccess(response.data)
  const data = embeddingResponseSchema.parse(response.data)
  if (data.data.length !== input.texts.length) {
    throw new Error('The embedding provider returned a different vector count.')
  }
  const vectors = new Array<number[]>(input.texts.length)
  for (const item of data.data) {
    if (item.index >= vectors.length || vectors[item.index] !== undefined) {
      throw new Error('The embedding provider returned invalid vector indexes.')
    }
    vectors[item.index] = item.embedding
  }
  return vectors
}

export interface IndexKnowledgeDocumentInput {
  knowledgeBaseId: string
  documentId: string
  embeddingModel: string
  text: string
  group?: string
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

/**
 * Run the full client-side indexing pipeline for one document: chunk, embed in
 * bounded batches, then replace the stored chunk set atomically. Every failure
 * is reported to the document row so the manager can offer a document-level
 * retry without another upload; the extracted text stays on the server.
 */
export async function indexKnowledgeDocument(
  input: IndexKnowledgeDocumentInput
): Promise<void> {
  const chunks = chunkKnowledgeText(input.text)
  if (chunks.length === 0) {
    throw new Error('The document does not contain indexable text.')
  }
  try {
    const vectors: number[][] = []
    for (
      let offset = 0;
      offset < chunks.length;
      offset += KNOWLEDGE_EMBEDDING_BATCH_SIZE
    ) {
      const batch = chunks.slice(
        offset,
        offset + KNOWLEDGE_EMBEDDING_BATCH_SIZE
      )
      const batchVectors = await requestKnowledgeEmbeddings({
        model: input.embeddingModel,
        texts: batch.map((chunk) => chunk.text),
        group: input.group,
        signal: input.signal,
      })
      if (batchVectors.length !== batch.length) {
        throw new Error('The embedding provider returned an incomplete batch.')
      }
      const dimensions = batchVectors[0]?.length ?? 0
      if (dimensions === 0 || dimensions > KNOWLEDGE_EMBEDDING_MAX_DIMS) {
        throw new Error('The embedding provider returned an invalid dimension.')
      }
      for (const vector of batchVectors) {
        if (vector.length !== dimensions) {
          throw new Error(
            'The embedding provider returned vectors with different dimensions.'
          )
        }
      }
      vectors.push(...batchVectors)
      input.onProgress?.(vectors.length, chunks.length)
    }

    const payload: KnowledgeChunksPayload = {
      embeddingModel: input.embeddingModel,
      dims: vectors[0].length,
      chunks: chunks.map((chunk: KnowledgeChunk, index) => ({
        index: chunk.index,
        text: chunk.text,
        embedding: encodeKnowledgeEmbedding(vectors[index]),
      })),
    }
    await replaceKnowledgeDocumentChunks(
      input.knowledgeBaseId,
      input.documentId,
      payload,
      input.signal
    )
  } catch (error) {
    if (!input.signal?.aborted) {
      const message =
        getServerMessage(error) ?? 'Knowledge indexing failed in the browser.'
      await failKnowledgeDocument(
        input.knowledgeBaseId,
        input.documentId,
        message
      ).catch(() => undefined)
    }
    throw error
  }
}
