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

import { readRequestIdHeader } from './api'
import { API_ENDPOINTS } from './constants'

export interface PlaygroundEmbeddingItem {
  index: number
  embedding: number[]
}

export interface PlaygroundEmbeddingResponse {
  model?: string
  items: PlaygroundEmbeddingItem[]
  usage?: {
    promptTokens?: number
    totalTokens?: number
  }
}

export interface PlaygroundRerankItem {
  index: number
  score: number
  document?: unknown
}

export interface PlaygroundRerankResponse {
  model?: string
  results: PlaygroundRerankItem[]
}

export interface PlaygroundModerationItem {
  flagged: boolean
  categories: Record<string, boolean>
  categoryScores: Record<string, number>
}

export interface PlaygroundModerationResponse {
  model?: string
  results: PlaygroundModerationItem[]
}

export interface PlaygroundNonChatOutcome<T> {
  data: T
  raw: unknown
  requestId?: string
}

const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough()

const embeddingResponseSchema = z
  .object({
    model: z.string().optional(),
    data: z.array(
      z
        .object({
          index: z.number().int().optional(),
          embedding: z.array(z.number()),
        })
        .passthrough()
    ),
    usage: usageSchema.optional(),
  })
  .passthrough()

const rerankResponseSchema = z
  .object({
    model: z.string().optional(),
    results: z.array(
      z
        .object({
          index: z.number().int(),
          relevance_score: z.number().optional(),
          score: z.number().optional(),
          document: z.unknown().optional(),
        })
        .passthrough()
    ),
    usage: usageSchema.optional(),
  })
  .passthrough()

const moderationResponseSchema = z
  .object({
    model: z.string().optional(),
    results: z.array(
      z
        .object({
          flagged: z.boolean(),
          categories: z.record(z.string(), z.boolean()).default({}),
          category_scores: z.record(z.string(), z.number()).default({}),
        })
        .passthrough()
    ),
  })
  .passthrough()

function invalidResponse(): Error {
  // An empty message lets the caller show its translated fallback instead of a
  // schema path or a provider payload.
  return new Error('')
}

export async function runEmbeddings(
  input: { model: string; group: string; inputs: string[] },
  signal?: AbortSignal
): Promise<PlaygroundNonChatOutcome<PlaygroundEmbeddingResponse>> {
  const response = await api.post(
    API_ENDPOINTS.EMBEDDINGS,
    {
      model: input.model,
      input: input.inputs,
      ...(input.group ? { group: input.group } : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const parsed = embeddingResponseSchema.safeParse(response.data)
  if (!parsed.success) {
    throw invalidResponse()
  }
  const items = parsed.data.data
    .map((item, position) => ({
      index: item.index ?? position,
      embedding: item.embedding,
    }))
    .sort((left, right) => left.index - right.index)
  return {
    data: {
      model: parsed.data.model,
      items,
      usage: parsed.data.usage
        ? {
            promptTokens: parsed.data.usage.prompt_tokens,
            totalTokens: parsed.data.usage.total_tokens,
          }
        : undefined,
    },
    raw: response.data,
    requestId: readRequestIdHeader(response.headers),
  }
}

export async function runRerank(
  input: {
    model: string
    group: string
    query: string
    documents: string[]
    topN?: number
  },
  signal?: AbortSignal
): Promise<PlaygroundNonChatOutcome<PlaygroundRerankResponse>> {
  const response = await api.post(
    API_ENDPOINTS.RERANK,
    {
      model: input.model,
      query: input.query,
      documents: input.documents,
      ...(input.group ? { group: input.group } : {}),
      ...(input.topN !== undefined ? { top_n: input.topN } : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const parsed = rerankResponseSchema.safeParse(response.data)
  if (!parsed.success) {
    throw invalidResponse()
  }
  const results: PlaygroundRerankItem[] = []
  for (const result of parsed.data.results) {
    const score = result.relevance_score ?? result.score
    if (score === undefined || Number.isNaN(score)) {
      throw invalidResponse()
    }
    results.push({
      index: result.index,
      score,
      document: result.document,
    })
  }
  return {
    data: { model: parsed.data.model, results },
    raw: response.data,
    requestId: readRequestIdHeader(response.headers),
  }
}

export async function runModerations(
  input: { model: string; group: string; inputs: string[] },
  signal?: AbortSignal
): Promise<PlaygroundNonChatOutcome<PlaygroundModerationResponse>> {
  const response = await api.post(
    API_ENDPOINTS.MODERATIONS,
    {
      model: input.model,
      input: input.inputs,
      ...(input.group ? { group: input.group } : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const parsed = moderationResponseSchema.safeParse(response.data)
  if (!parsed.success) {
    throw invalidResponse()
  }
  return {
    data: {
      model: parsed.data.model,
      results: parsed.data.results.map((result) => ({
        flagged: result.flagged,
        categories: result.categories,
        categoryScores: result.category_scores,
      })),
    },
    raw: response.data,
    requestId: readRequestIdHeader(response.headers),
  }
}
