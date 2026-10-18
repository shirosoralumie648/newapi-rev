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

export const STORAGE_VERSION = 2
export const MAX_STORED_MESSAGES = 100
export const MAX_STORED_MESSAGES_BYTES = 1024 * 1024
export const MAX_STORED_SESSIONS_BYTES = 4 * MAX_STORED_MESSAGES_BYTES
export const MAX_LOADED_MESSAGES_CHARS = 120_000
export const MAX_LOADED_MESSAGE_CHARS = 40_000

export const playgroundConfigSchema = z.object({
  model: z.string().optional(),
  group: z.string().optional(),
  temperature: z.number().finite().optional(),
  top_p: z.number().finite().optional(),
  max_tokens: z.number().finite().optional(),
  frequency_penalty: z.number().finite().optional(),
  presence_penalty: z.number().finite().optional(),
  seed: z.number().finite().nullable().optional(),
  // Kept permissive on purpose: payload-builder only forwards a value the
  // relay accepts, so an edited store cannot produce an invalid request.
  reasoning_effort: z.string().max(16).optional(),
  stream: z.boolean().optional(),
})

export const parameterEnabledSchema = z.object({
  temperature: z.boolean().optional(),
  top_p: z.boolean().optional(),
  max_tokens: z.boolean().optional(),
  frequency_penalty: z.boolean().optional(),
  presence_penalty: z.boolean().optional(),
  seed: z.boolean().optional(),
  reasoning_effort: z.boolean().optional(),
})

// Context management settings of one conversation. The stored shape stays
// opaque here on purpose: a locally stored value that no longer matches any
// version's contract must never make the whole conversation unreadable, so
// normalizeContextSettings clamps or defaults every field of it.
export const playgroundContextSchema = z.unknown()

// The persisted compression node, opaque for the same reason.
// normalizeContextSummary turns anything unusable into "no summary".
export const playgroundContextSummarySchema = z.unknown()

const messageRoleSchema = z.enum(['user', 'assistant', 'system'])
const messageStatusSchema = z.enum([
  'loading',
  'streaming',
  'complete',
  'error',
])

const messageAttachmentSchema = z.object({
  id: z.string().min(1).max(200),
  url: z.string().max(4096),
  mediaType: z.string().max(200),
  filename: z.string().max(255).optional(),
  byteSize: z.number().int().nonnegative().optional(),
})

const messageToolCallStatusSchema = z.enum([
  'pending',
  'completed',
  'denied',
  'error',
])

// Bounds stay permissive on purpose: rejecting a snapshot would drop the whole
// stored conversation. The server policy limits stay authoritative.
const messageToolCallSchema = z.object({
  id: z.string().max(500),
  name: z.string().max(500),
  arguments: z.string(),
  status: messageToolCallStatusSchema,
  result: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number().finite().optional(),
  completedAt: z.number().finite().optional(),
})

const messageVersionSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string(),
  // Parallel comparison labels each compared reply with its model and its own
  // lifecycle; the server bounds the model name and the status enum.
  model: z.string().max(512).optional(),
  status: messageStatusSchema.optional(),
  errorCode: z.string().max(500).nullable().optional(),
  attachments: z.array(messageAttachmentSchema).optional(),
  toolCalls: z.array(messageToolCallSchema).optional(),
  // Display-only generation record. A stored version that carries it keeps the
  // relay request id (64 characters, the logs.request_id column) and the token
  // usage the relay reported; the settle log stays the billing source.
  requestId: z.string().min(1).max(64).optional(),
  usage: z
    .object({
      promptTokens: z.number().finite().nonnegative(),
      completionTokens: z.number().finite().nonnegative(),
      totalTokens: z.number().finite().nonnegative(),
    })
    .optional(),
})

const sourceSchema = z.object({
  href: z.string().max(4096),
  title: z.string().max(500),
})

const reasoningSchema = z.object({
  content: z.string(),
  duration: z.number().finite(),
  startedAt: z.number().finite().optional(),
  completedAt: z.number().finite().optional(),
  durationMs: z.number().finite().optional(),
})

const messageSchema = z.object({
  key: z.string().min(1).max(200),
  from: messageRoleSchema,
  versions: z.array(messageVersionSchema).min(1),
  /** Assistant message group of one parallel comparison. */
  parallel: z.boolean().optional(),
  activeVersionIndex: z.number().int().nonnegative().optional(),
  createdAt: z.number().finite().optional(),
  startedAt: z.number().finite().optional(),
  completedAt: z.number().finite().optional(),
  durationMs: z.number().finite().optional(),
  sources: z.array(sourceSchema).optional(),
  reasoning: reasoningSchema.optional(),
  isReasoningStreaming: z.boolean().optional(),
  isReasoningComplete: z.boolean().optional(),
  isContentComplete: z.boolean().optional(),
  status: messageStatusSchema.optional(),
  errorCode: z.string().max(500).nullable().optional(),
})

export const messagesSchema = z.array(messageSchema)

const storedConfigSchema = playgroundConfigSchema.required()
const storedParameterEnabledSchema = parameterEnabledSchema.required()

export const playgroundSessionSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(200),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  config: storedConfigSchema,
  parameterEnabled: storedParameterEnabledSchema,
  /** Absent in data written before the conversation system prompt existed. */
  systemPrompt: z.string().optional(),
  /** Absent in data written before context management existed. */
  context: playgroundContextSchema.optional(),
  /** Absent or null when the conversation sends its full stored history. */
  contextSummary: playgroundContextSummarySchema.nullable().optional(),
  messages: messagesSchema,
  server: z
    .object({
      id: z.string().min(1).max(128),
      revision: z.number().int().nonnegative(),
      messageRevision: z.number().int().nonnegative(),
    })
    .optional(),
  syncPending: z.boolean().optional(),
})

export const playgroundSessionsStateSchema = z.object({
  activeSessionId: z.string().min(1).max(128),
  sessions: z.array(playgroundSessionSchema),
})
