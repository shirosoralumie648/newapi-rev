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
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  API_ENDPOINTS,
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  PLAYGROUND_REQUEST_ID_HEADER,
} from './constants'
import {
  messagesSchema,
  playgroundConfigSchema,
  parameterEnabledSchema,
} from './lib/storage/storage-schema'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelOption,
  GroupOption,
  Message,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundMessageCost,
  PlaygroundServerSession,
} from './types'

/** One non-streaming completion plus the relay request id it was recorded as. */
export interface ChatCompletionResult {
  response: ChatCompletionResponse
  requestId?: string
}

// Axios lower-cases response header names; the relay writes the request id it
// logged into this header.
function readRequestIdHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const value = (headers as Record<string, unknown>)[
    PLAYGROUND_REQUEST_ID_HEADER.toLowerCase()
  ]
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text : undefined
}

/**
 * Send chat completion request (non-streaming)
 */
export async function sendChatCompletion(
  payload: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  const res = await api.post(API_ENDPOINTS.CHAT_COMPLETIONS, payload, {
    signal,
    skipErrorHandler: true,
  } as Record<string, unknown>)
  return {
    response: res.data as ChatCompletionResponse,
    requestId: readRequestIdHeader(res.headers),
  }
}

/**
 * Get user available models
 */
export async function getUserModels(group: string): Promise<ModelOption[]> {
  const res = await api.get(API_ENDPOINTS.USER_MODELS, {
    params: { group },
  })
  const { data } = res
  requireServerSuccess(data)

  if (!data.success || !Array.isArray(data.data)) {
    return []
  }

  return data.data.map((model: string) => ({
    label: model,
    value: model,
  }))
}

/**
 * Get user groups
 */
export async function getUserGroups(): Promise<GroupOption[]> {
  const res = await api.get(API_ENDPOINTS.USER_GROUPS)
  const { data } = res
  requireServerSuccess(data)

  if (!data.success || !data.data) {
    return []
  }

  const groupData = data.data as Record<
    string,
    { desc: string; ratio: number | string }
  >

  // label is for button display (name only); desc is for dropdown content
  return Object.entries(groupData).map(([group, info]) => ({
    label: group,
    value: group,
    ratio: info.ratio,
    desc: info.desc,
  }))
}

const serverSessionSchema = z.object({
  created: z.boolean().optional(),
  id: z.string().min(1),
  client_id: z.string().optional(),
  title: z.string(),
  config: playgroundConfigSchema,
  parameter_enabled: parameterEnabledSchema,
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  message_revision: z.number().int().nonnegative(),
})

export interface PlaygroundSessionInput {
  title?: string
  client_id?: string
  config?: PlaygroundConfig
  parameter_enabled?: ParameterEnabled
  revision?: number
  messages?: Message[]
}

export interface PlaygroundMessageSnapshot {
  revision: number
  messages: Message[]
}

const serverAttachmentSchema = z.object({
  created: z.boolean().optional(),
  id: z.string().min(1),
  client_key: z.string().optional(),
  session_id: z.string().min(1),
  media_type: z.string().min(1),
  filename: z.string(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const serverMessageAttachmentSchema = z.object({
  id: z.string().min(1),
  media_type: z.string().min(1),
  filename: z.string(),
  byte_size: z.number().int().nonnegative(),
})

export interface PlaygroundServerAttachment {
  id: string
  clientKey?: string
  sessionId: string
  mediaType: string
  filename: string
  byteSize: number
  createdAt: number
  updatedAt: number
}

export interface PlaygroundAttachmentUploadInput {
  clientKey: string
  mediaType: string
  /** Base64 payload without the data URL prefix. */
  data: string
  filename?: string
}

export function playgroundAttachmentContentUrl(
  sessionId: string,
  attachmentId: string
): string {
  return `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(
    sessionId
  )}/attachments/${encodeURIComponent(attachmentId)}/content`
}

function mapServerAttachment(value: unknown): PlaygroundServerAttachment {
  const attachment = serverAttachmentSchema.parse(value)
  return {
    id: attachment.id,
    clientKey: attachment.client_key,
    sessionId: attachment.session_id,
    mediaType: attachment.media_type,
    filename: attachment.filename,
    byteSize: attachment.byte_size,
    createdAt: attachment.created_at * 1000,
    updatedAt: attachment.updated_at * 1000,
  }
}

// The stored message snapshot keeps attachment references only; display and
// request fields are derived from the owned attachment rows on read.
function normalizeServerMessagePayload(
  payload: unknown,
  sessionId: string
): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const versions = (payload as { versions?: unknown }).versions
  if (!Array.isArray(versions)) return payload
  return {
    ...(payload as Record<string, unknown>),
    versions: versions.map((version) => {
      if (!version || typeof version !== 'object') return version
      const attachments = (version as { attachments?: unknown }).attachments
      if (!Array.isArray(attachments) || attachments.length === 0)
        return version
      return {
        ...(version as Record<string, unknown>),
        attachments: attachments.map((attachment) => {
          const stored = serverMessageAttachmentSchema.safeParse(attachment)
          if (!stored.success) return attachment
          return {
            id: stored.data.id,
            url: playgroundAttachmentContentUrl(sessionId, stored.data.id),
            mediaType: stored.data.media_type,
            filename: stored.data.filename,
            byteSize: stored.data.byte_size,
          }
        }),
      }
    }),
  }
}

function mapServerSession(value: unknown): PlaygroundServerSession {
  const session = serverSessionSchema.parse(value)
  return {
    id: session.id,
    clientId: session.client_id,
    title: session.title,
    config: { ...DEFAULT_CONFIG, ...session.config },
    parameterEnabled: {
      ...DEFAULT_PARAMETER_ENABLED,
      ...session.parameter_enabled,
    },
    createdAt: session.created_at * 1000,
    updatedAt: session.updated_at * 1000,
    revision: session.revision,
    messageRevision: session.message_revision,
  }
}

export async function getPlaygroundSessions(
  signal?: AbortSignal
): Promise<PlaygroundServerSession[]> {
  const result: PlaygroundServerSession[] = []
  let page = 1
  while (true) {
    const response = await api.get(API_ENDPOINTS.PLAYGROUND_SESSIONS, {
      params: { p: page, page_size: 100 },
      signal,
    })
    requireServerSuccess(response.data)
    const data = z
      .object({
        items: z.array(serverSessionSchema),
        total: z.number().nonnegative(),
      })
      .parse(response.data.data)
    result.push(...data.items.map(mapServerSession))
    if (result.length >= data.total || data.items.length === 0) return result
    page += 1
  }
}

export async function createPlaygroundSession(
  input: PlaygroundSessionInput,
  signal?: AbortSignal
): Promise<PlaygroundServerSession & { created: boolean }> {
  const response = await api.post(
    API_ENDPOINTS.PLAYGROUND_SESSIONS,
    {
      ...input,
      messages: input.messages?.map((message) => ({
        client_key: message.key,
        payload: message,
      })),
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return {
    ...mapServerSession(response.data.data),
    created: response.data.data.created === true,
  }
}

export async function updatePlaygroundSession(
  sessionId: string,
  input: PlaygroundSessionInput,
  signal?: AbortSignal
): Promise<PlaygroundServerSession> {
  const response = await api.patch(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}`,
    input,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerSession(response.data.data)
}

export async function deletePlaygroundSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}

function mapMessageSnapshot(
  value: unknown,
  sessionId: string
): PlaygroundMessageSnapshot {
  const data = z
    .object({
      revision: z.number().int().nonnegative(),
      messages: z.array(
        z.object({ client_key: z.string(), payload: z.unknown() })
      ),
    })
    .parse(value)
  return {
    revision: data.revision,
    messages: messagesSchema.parse(
      data.messages.map((message) =>
        normalizeServerMessagePayload(message.payload, sessionId)
      )
    ),
  }
}

export async function getPlaygroundMessages(
  sessionId: string,
  signal?: AbortSignal
): Promise<PlaygroundMessageSnapshot> {
  const response = await api.get(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/messages`,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapMessageSnapshot(response.data.data, sessionId)
}

/**
 * One incremental message write: the messages that changed or were added plus
 * the client keys that were removed. The server writes only those rows and uses
 * `revision` as the CAS token, so a stale revision fails with 409.
 */
export interface PlaygroundMessageDelta {
  upserts: Message[]
  deletes: string[]
}

export async function applyPlaygroundMessagesDelta(
  sessionId: string,
  delta: PlaygroundMessageDelta,
  revision: number,
  signal?: AbortSignal
): Promise<number> {
  const response = await api.patch(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/messages`,
    {
      revision,
      upserts: delta.upserts.map((message) => ({
        client_key: message.key,
        payload: message,
      })),
      deletes: delta.deletes,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  const data = z
    .object({ revision: z.number().int().nonnegative() })
    .parse(response.data.data)
  return data.revision
}

/**
 * @deprecated Compatibility shim for one release: the full snapshot endpoint
 * stays available and the server translates it into incremental writes, but new
 * clients must use {@link applyPlaygroundMessagesDelta}. It will be removed in
 * the next version.
 */
export async function replacePlaygroundMessages(
  sessionId: string,
  messages: Message[],
  revision: number,
  signal?: AbortSignal
): Promise<PlaygroundMessageSnapshot> {
  const response = await api.put(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/messages`,
    {
      revision,
      messages: messages.map((message) => ({
        client_key: message.key,
        payload: message,
      })),
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return mapMessageSnapshot(response.data.data, sessionId)
}

export async function uploadPlaygroundAttachment(
  sessionId: string,
  input: PlaygroundAttachmentUploadInput,
  signal?: AbortSignal
): Promise<{ attachment: PlaygroundServerAttachment; created: boolean }> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/attachments`,
    {
      client_key: input.clientKey,
      media_type: input.mediaType,
      filename: input.filename,
      data: input.data,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  return {
    attachment: mapServerAttachment(response.data.data),
    created: response.data.data.created === true,
  }
}

export async function deletePlaygroundAttachment(
  sessionId: string,
  attachmentId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}

export async function getPlaygroundAttachmentContent(
  contentUrl: string,
  signal?: AbortSignal
): Promise<Blob> {
  const response = await api.get(contentUrl, {
    responseType: 'blob',
    signal,
  } as Record<string, unknown>)
  return response.data as Blob
}

const playgroundUsageMetricSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  used_bytes: z.number().int().nonnegative(),
  limit_bytes: z.number().int().nonnegative(),
})

const playgroundMessageCostSchema = z.object({
  request_id: z.string().min(1),
  quota: z.number(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  model_name: z.string().optional(),
  created_at: z.number().int().nonnegative(),
})

const playgroundMessageCostLookupSchema = z.object({
  enabled: z.boolean(),
  items: z.array(playgroundMessageCostSchema),
})

const playgroundUsageSchema = z.object({
  sessions: playgroundUsageMetricSchema,
  attachments: playgroundUsageMetricSchema,
  artifacts: playgroundUsageMetricSchema,
  canvas: playgroundUsageMetricSchema,
  tasks: playgroundUsageMetricSchema,
})

export interface PlaygroundUsageMetric {
  used: number
  limit: number
  usedBytes: number
  limitBytes: number
}

// The unified Playground resource usage: conversations, attachments, artifacts,
// canvases and async generation tasks the owner stores, each against the
// account-level cap the server enforces for the owner's group.
export interface PlaygroundResourceUsage {
  sessions: PlaygroundUsageMetric
  attachments: PlaygroundUsageMetric
  artifacts: PlaygroundUsageMetric
  canvas: PlaygroundUsageMetric
  tasks: PlaygroundUsageMetric
}

/**
 * The settled consume rows of the requested relay requests, by request id.
 * `enabled` mirrors the runtime consume-log setting: when it is false no row
 * will ever appear and the caller must not keep waiting for one.
 */
export interface PlaygroundMessageCostLookup {
  enabled: boolean
  costs: Map<string, PlaygroundMessageCost>
}

/**
 * Read-only lookup of the caller's own settled consume rows for the given
 * relay requests. It never reserves, settles or refunds quota; the returned
 * figures are the rows the gateway already wrote.
 */
export async function getPlaygroundMessageCosts(
  requestIds: string[],
  signal?: AbortSignal
): Promise<PlaygroundMessageCostLookup> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_MESSAGE_COSTS, {
    params: { request_ids: requestIds.join(',') },
    signal,
  })
  requireServerSuccess(response.data)
  const data = playgroundMessageCostLookupSchema.parse(response.data.data)
  const costs = new Map<string, PlaygroundMessageCost>()
  for (const item of data.items) {
    costs.set(item.request_id, {
      requestId: item.request_id,
      quota: item.quota,
      promptTokens: item.prompt_tokens,
      completionTokens: item.completion_tokens,
      totalTokens: item.total_tokens,
      modelName: item.model_name ?? '',
      createdAt: item.created_at * 1000,
    })
  }
  return { enabled: data.enabled, costs }
}

export async function getPlaygroundUsage(
  signal?: AbortSignal
): Promise<PlaygroundResourceUsage> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_USAGE, { signal })
  requireServerSuccess(response.data)
  const metrics = playgroundUsageSchema.parse(response.data.data)
  const toMetric = (
    source: z.output<typeof playgroundUsageMetricSchema>
  ): PlaygroundUsageMetric => ({
    used: source.used,
    limit: source.limit,
    usedBytes: source.used_bytes,
    limitBytes: source.limit_bytes,
  })
  return {
    sessions: toMetric(metrics.sessions),
    attachments: toMetric(metrics.attachments),
    artifacts: toMetric(metrics.artifacts),
    canvas: toMetric(metrics.canvas),
    tasks: toMetric(metrics.tasks),
  }
}
