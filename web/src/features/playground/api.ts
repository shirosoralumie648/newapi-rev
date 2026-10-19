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
  PLAYGROUND_WORKFLOW_RUN_HEADER,
} from './constants'
import {
  normalizeContextSettings,
  normalizeContextSummary,
} from './lib/context/playground-context'
import {
  messagesSchema,
  playgroundConfigSchema,
  parameterEnabledSchema,
} from './lib/storage/storage-schema'
import type {
  AssistantPreset,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelOption,
  GroupOption,
  Message,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  PlaygroundExportFormat,
  PlaygroundMessageCost,
  PlaygroundServerSession,
  PlaygroundPresetExport,
  PlaygroundSessionExport,
  PlaygroundTrashListing,
  PromptSnippet,
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
 *
 * `workflowRunId` is the budget of a canvas workflow run the request belongs
 * to; it travels in a header the relay consumes, so a step bills inside the
 * run budget instead of the wallet directly.
 */
export async function sendChatCompletion(
  payload: ChatCompletionRequest,
  signal?: AbortSignal,
  workflowRunId?: string
): Promise<ChatCompletionResult> {
  const res = await api.post(API_ENDPOINTS.CHAT_COMPLETIONS, payload, {
    signal,
    skipErrorHandler: true,
    ...(workflowRunId
      ? { headers: { [PLAYGROUND_WORKFLOW_RUN_HEADER]: workflowRunId } }
      : {}),
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
    { desc: string; ratio: number | string; name?: string }
  >

  // value is the stable identifier submitted with the request; the label is the
  // editable display name (falling back to the identifier) and desc is for
  // dropdown content.
  return Object.entries(groupData).map(([group, info]) => ({
    label: info.name?.trim() || group,
    value: group,
    ratio: info.ratio,
    desc: info.desc,
  }))
}

// Wire shapes of the session context fields. The server speaks snake_case; the
// stored/state shapes stay camelCase like the rest of the playground types.
const serverContextSettingsSchema = z.object({
  history_limit: z.number().finite().nonnegative().optional(),
  token_budget: z.number().finite().nonnegative().optional(),
  auto_summarize: z.boolean().optional(),
  summary_model: z.string().max(512).optional(),
})

const serverContextSummarySchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string(),
  through_message_key: z.string().min(1).max(200),
  message_count: z.number().finite().nonnegative().optional(),
  model: z.string().max(512).optional(),
  created_at: z.number().finite().optional(),
  request_id: z.string().min(1).max(64).optional(),
  usage: z
    .object({
      promptTokens: z.number().finite().nonnegative(),
      completionTokens: z.number().finite().nonnegative(),
      totalTokens: z.number().finite().nonnegative(),
    })
    .optional(),
})

const serverSessionSchema = z.object({
  created: z.boolean().optional(),
  id: z.string().min(1),
  client_id: z.string().optional(),
  title: z.string(),
  config: playgroundConfigSchema,
  parameter_enabled: parameterEnabledSchema,
  system_prompt: z.string().optional(),
  opening_message: z.string().optional(),
  suggested_questions: z.array(z.string()).optional(),
  context: serverContextSettingsSchema.optional(),
  context_summary: serverContextSummarySchema.nullable().optional(),
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
  system_prompt?: string
  opening_message?: string
  suggested_questions?: string[]
  context?: PlaygroundContextSettings
  context_summary?: PlaygroundContextSummary | null
  revision?: number
  messages?: Message[]
}

// Translate the local context settings and compression node into the wire
// shape; an explicitly null summary stays null so the server clears it.
function serializeSessionContextInput(
  input: PlaygroundSessionInput
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...input }
  if (input.context) {
    payload.context = {
      history_limit: input.context.historyLimit,
      token_budget: input.context.tokenBudget,
      auto_summarize: input.context.autoSummarize,
      summary_model: input.context.summaryModel,
    }
  }
  if (input.context_summary !== undefined) {
    const summary = input.context_summary
    payload.context_summary = summary
      ? {
          id: summary.id,
          content: summary.content,
          through_message_key: summary.throughMessageKey,
          message_count: summary.messageCount,
          model: summary.model,
          created_at: summary.createdAt,
          ...(summary.requestId ? { request_id: summary.requestId } : {}),
          ...(summary.usage ? { usage: summary.usage } : {}),
        }
      : null
  }
  return payload
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

/**
 * Content URL of one attachment. The `partitionId` is the attachment's owning
 * resource: a conversation id for a chat upload, or a canvas id for a file
 * dropped on a board. The server resolves the row by owner and partition and
 * serves the bytes under the stored media type.
 */
export function playgroundAttachmentContentUrl(
  partitionId: string,
  attachmentId: string
): string {
  return `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(
    partitionId
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

// One stored attachment/reference keeps the owned metadata; the client adds the
// content URL of the owning conversation, which is the only field the server
// derives on read.
function normalizeServerMessageAttachment(
  attachment: unknown,
  sessionId: string
): unknown {
  const stored = serverMessageAttachmentSchema.safeParse(attachment)
  if (!stored.success) return attachment
  return {
    id: stored.data.id,
    url: playgroundAttachmentContentUrl(sessionId, stored.data.id),
    mediaType: stored.data.media_type,
    filename: stored.data.filename,
    byteSize: stored.data.byte_size,
  }
}

// The stored message snapshot keeps attachment references only; display and
// request fields are derived from the owned attachment rows on read. A cached
// read-aloud reference (`speech`) is resolved the same way.
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
      const record = version as Record<string, unknown>
      const attachments = Array.isArray(record.attachments)
        ? record.attachments
        : null
      const speech = record.speech ?? null
      if (!attachments?.length && !speech) return version
      return {
        ...record,
        ...(attachments?.length
          ? {
              attachments: attachments.map((attachment) =>
                normalizeServerMessageAttachment(attachment, sessionId)
              ),
            }
          : {}),
        ...(speech
          ? { speech: normalizeServerMessageAttachment(speech, sessionId) }
          : {}),
      }
    }),
  }
}

function mapServerContextSummary(value: unknown): unknown {
  if (value == null) return null
  const parsed = serverContextSummarySchema.safeParse(value)
  if (!parsed.success) return null
  return {
    id: parsed.data.id,
    content: parsed.data.content,
    throughMessageKey: parsed.data.through_message_key,
    messageCount: parsed.data.message_count,
    model: parsed.data.model,
    createdAt: parsed.data.created_at,
    requestId: parsed.data.request_id,
    usage: parsed.data.usage,
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
    systemPrompt: session.system_prompt ?? '',
    openingMessage: session.opening_message ?? '',
    suggestedQuestions: session.suggested_questions ?? [],
    context: normalizeContextSettings({
      historyLimit: session.context?.history_limit,
      tokenBudget: session.context?.token_budget,
      autoSummarize: session.context?.auto_summarize,
      summaryModel: session.context?.summary_model,
    }),
    contextSummary: normalizeContextSummary(
      mapServerContextSummary(session.context_summary)
    ),
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
      ...serializeSessionContextInput(input),
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
    serializeSessionContextInput(input),
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

/**
 * One conversation export rendered by the host: Markdown or JSON with
 * attachment references instead of attachment bodies. A trashed conversation
 * can be exported before it is restored or purged.
 */
export async function exportPlaygroundSession(
  sessionId: string,
  format: PlaygroundExportFormat,
  signal?: AbortSignal
): Promise<PlaygroundSessionExport> {
  const response = await api.get(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/export`,
    { params: { format }, signal }
  )
  requireServerSuccess(response.data)
  const data = z
    .object({
      format: z.enum(['markdown', 'json']),
      filename: z.string().min(1),
      content_type: z.string().min(1),
      content: z.string(),
    })
    .parse(response.data.data)
  return {
    format: data.format,
    filename: data.filename,
    contentType: data.content_type,
    content: data.content,
  }
}

const playgroundTrashItemSchema = z.object({
  kind: z.enum(['session', 'canvas']),
  id: z.string().min(1),
  title: z.string(),
  deleted_at: z.number().int().nonnegative(),
  purge_at: z.number().int().nonnegative(),
})

/**
 * The account's trash: every trashed conversation and canvas plus the owner's
 * effective retention window. Trashed rows still count against the resource
 * quotas until the retention sweep purges them.
 */
export async function getPlaygroundTrash(
  signal?: AbortSignal
): Promise<PlaygroundTrashListing> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_TRASH, { signal })
  requireServerSuccess(response.data)
  const data = z
    .object({
      retention_days: z.number().int().positive(),
      items: z.array(playgroundTrashItemSchema),
    })
    .parse(response.data.data)
  return {
    retentionDays: data.retention_days,
    items: data.items.map((item) => ({
      kind: item.kind,
      id: item.id,
      title: item.title,
      deletedAt: item.deleted_at * 1000,
      purgeAt: item.purge_at * 1000,
    })),
  }
}

/** Restores a trashed conversation and answers its refreshed server row. */
export async function restorePlaygroundSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<PlaygroundServerSession> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/restore`,
    undefined,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerSession(response.data.data)
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

async function postPlaygroundAttachment(
  path: string,
  input: PlaygroundAttachmentUploadInput,
  signal?: AbortSignal
): Promise<{ attachment: PlaygroundServerAttachment; created: boolean }> {
  const response = await api.post(
    path,
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

export function uploadPlaygroundAttachment(
  sessionId: string,
  input: PlaygroundAttachmentUploadInput,
  signal?: AbortSignal
): Promise<{ attachment: PlaygroundServerAttachment; created: boolean }> {
  return postPlaygroundAttachment(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/attachments`,
    input,
    signal
  )
}

/**
 * Uploads one file of the canvas workspace. A canvas owns its own attachment
 * partition, so a file dropped on the board is stored without inventing a
 * conversation for it; the server checks the project for the account first.
 * The returned attachment carries the canvas id as its partition, which is what
 * the content route and the node reference use.
 */
export function uploadCanvasAttachment(
  canvasId: string,
  input: PlaygroundAttachmentUploadInput,
  signal?: AbortSignal
): Promise<{ attachment: PlaygroundServerAttachment; created: boolean }> {
  return postPlaygroundAttachment(
    `${API_ENDPOINTS.PLAYGROUND_CANVASES}/${encodeURIComponent(canvasId)}/attachments`,
    input,
    signal
  )
}

// One reservation answers with the mode the client must use for the bytes:
// a presigned URL, the relay route of this gateway, or the attachment a
// previous attempt with the same client key already produced.
const serverUploadSchema = z.object({
  id: z.string().optional(),
  mode: z.enum(['presigned', 'relay', 'completed']),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  expires_at: z.number().int().optional(),
  attachment: serverAttachmentSchema.optional(),
})

export type PlaygroundUploadMode = 'presigned' | 'relay' | 'completed'

export interface PlaygroundUploadTarget {
  /** Reservation id; absent when the client key already completed. */
  id?: string
  mode: PlaygroundUploadMode
  url?: string
  headers?: Record<string, string>
  attachment?: PlaygroundServerAttachment
}

export interface PlaygroundUploadInput {
  clientKey: string
  mediaType: string
  filename?: string
  byteSize: number
  /** Exactly one partition id is named per request. */
  sessionId?: string
  canvasId?: string
}

/**
 * Reserves the account budget for one file before its bytes move. The server
 * locks the partition and the usage counters in one transaction, so the quota
 * answer is final before the client starts a possibly long transfer.
 */
export async function beginPlaygroundUpload(
  input: PlaygroundUploadInput,
  signal?: AbortSignal
): Promise<PlaygroundUploadTarget> {
  const response = await api.post(
    API_ENDPOINTS.PLAYGROUND_UPLOADS,
    {
      client_key: input.clientKey,
      media_type: input.mediaType,
      filename: input.filename ?? '',
      byte_size: input.byteSize,
      session_id: input.sessionId,
      canvas_id: input.canvasId,
    },
    { signal }
  )
  requireServerSuccess(response.data)
  const upload = serverUploadSchema.parse(response.data.data)
  return {
    id: upload.id,
    mode: upload.mode,
    url: upload.url,
    headers: upload.headers,
    attachment: upload.attachment
      ? mapServerAttachment(upload.attachment)
      : undefined,
  }
}

/**
 * Relays the bytes of a reservation through the gateway. Used when the object
 * store cannot sign a URL, and as the fallback when a presigned PUT is refused
 * by the browser (for example because the bucket lacks the required CORS rule).
 */
export async function putPlaygroundUploadContent(
  uploadId: string,
  body: Blob,
  mediaType: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.put(
    `${API_ENDPOINTS.PLAYGROUND_UPLOADS}/${encodeURIComponent(uploadId)}/content`,
    body,
    { headers: { 'Content-Type': mediaType }, signal }
  )
  requireServerSuccess(response.data)
}

/**
 * Asks the server to verify the written object (size plus leading magic bytes)
 * and turn the reservation into an attachment. A failed verification deletes
 * the object and releases the reservation server-side.
 */
export async function completePlaygroundUpload(
  uploadId: string,
  signal?: AbortSignal
): Promise<{ attachment: PlaygroundServerAttachment; created: boolean }> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_UPLOADS}/${encodeURIComponent(uploadId)}/complete`,
    {},
    { signal }
  )
  requireServerSuccess(response.data)
  return {
    attachment: mapServerAttachment(response.data.data),
    created: response.data.data.created === true,
  }
}

/** Cancels a reservation; releasing an already deleted one is a no-op here. */
export async function cancelPlaygroundUpload(
  uploadId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_UPLOADS}/${encodeURIComponent(uploadId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
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

const serverDocumentTextSchema = z.object({
  id: z.string().min(1),
  filename: z.string(),
  media_type: z.string().min(1),
  text: z.string(),
  byte_size: z.number().int().nonnegative(),
  page_count: z.number().int().nonnegative(),
})

export interface PlaygroundDocumentText {
  id: string
  filename: string
  mediaType: string
  /** Extracted text; byteSize counts the text, pageCount only a PDF. */
  text: string
  byteSize: number
  pageCount: number
}

/**
 * Text URL of one document attachment. The extraction endpoint lives next to
 * the content endpoint, so the stored content URL names the partition and
 * encodes the attachment id.
 */
export function playgroundDocumentTextUrl(contentUrl: string): string {
  const suffix = '/content'
  return contentUrl.endsWith(suffix)
    ? `${contentUrl.slice(0, -suffix.length)}/text`
    : `${contentUrl}/text`
}

/**
 * Reads the text of one document attachment. The server extracts lazily and
 * caches the outcome, so later reads of the same revision answer from the
 * cache; a document without readable text answers with its stable code.
 */
export async function getPlaygroundDocumentText(
  contentUrl: string,
  signal?: AbortSignal
): Promise<PlaygroundDocumentText> {
  const response = await api.get(playgroundDocumentTextUrl(contentUrl), {
    signal,
  })
  requireServerSuccess(response.data)
  const document = serverDocumentTextSchema.parse(response.data.data)
  return {
    id: document.id,
    filename: document.filename,
    mediaType: document.media_type,
    text: document.text,
    byteSize: document.byte_size,
    pageCount: document.page_count,
  }
}

const playgroundUsageMetricSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  used_bytes: z.number().int().nonnegative(),
  limit_bytes: z.number().int().nonnegative(),
})

const playgroundRequestTimingSchema = z.object({
  total_ms: z.number().optional(),
  auth_ms: z.number().optional(),
  channel_select_ms: z.number().optional(),
  upstream_ms: z.number().optional(),
  first_token_ms: z.number().optional(),
  retries: z.number().int().optional(),
})

const playgroundMessageCostSchema = z.object({
  request_id: z.string().min(1),
  quota: z.number(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  model_name: z.string().optional(),
  created_at: z.number().int().nonnegative(),
  timing: playgroundRequestTimingSchema.optional(),
})

const playgroundMessageCostLookupSchema = z.object({
  enabled: z.boolean(),
  items: z.array(playgroundMessageCostSchema),
})

const playgroundUsageSchema = z.object({
  group: z.string(),
  sessions: playgroundUsageMetricSchema,
  attachments: playgroundUsageMetricSchema,
  artifacts: playgroundUsageMetricSchema,
  canvas: playgroundUsageMetricSchema,
  canvas_snapshots: playgroundUsageMetricSchema,
  storage: playgroundUsageMetricSchema,
  tasks: playgroundUsageMetricSchema,
})

const playgroundSettingsSchema = z.object({
  sandbox_preview_enabled: z.boolean(),
})

export interface PlaygroundUsageMetric {
  used: number
  limit: number
  usedBytes: number
  limitBytes: number
}

// The unified Playground resource usage: conversations, attachments, artifacts,
// canvases, canvas history, object storage and async generation tasks the owner
// stores, each against the account-level cap the server enforces for the
// owner's group. `group` is the user group those limits were resolved from.
export interface PlaygroundResourceUsage {
  group: string
  sessions: PlaygroundUsageMetric
  attachments: PlaygroundUsageMetric
  artifacts: PlaygroundUsageMetric
  canvas: PlaygroundUsageMetric
  canvasSnapshots: PlaygroundUsageMetric
  storage: PlaygroundUsageMetric
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
      timing: item.timing,
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
    group: metrics.group,
    sessions: toMetric(metrics.sessions),
    attachments: toMetric(metrics.attachments),
    artifacts: toMetric(metrics.artifacts),
    canvas: toMetric(metrics.canvas),
    canvasSnapshots: toMetric(metrics.canvas_snapshots),
    storage: toMetric(metrics.storage),
    tasks: toMetric(metrics.tasks),
  }
}

const playgroundStorageLedgerRowSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  date: z.string(),
  peak_bytes: z.number().int().nonnegative(),
  free_bytes: z.number().int().nonnegative(),
  billable_bytes: z.number().int().nonnegative(),
  egress_bytes: z.number().int().nonnegative(),
  egress_requests: z.number().int().nonnegative(),
  quota: z.number().int(),
  debt_quota: z.number().int(),
  egress_quota: z.number().int(),
  status: z.string(),
  grace_until: z.number().int().nonnegative(),
  settled_at: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

const playgroundStorageBillingSchema = z.object({
  enabled: z.boolean(),
  group: z.string(),
  price_usd_per_gb_month: z.number(),
  free_bytes: z.number().int().nonnegative(),
  apply_group_ratio: z.boolean(),
  grace_days: z.number().int().nonnegative(),
  egress_mode: z.string(),
  egress_price_usd_per_gb: z.number(),
  egress_daily_bytes_limit: z.number().int().nonnegative(),
  egress_daily_requests_limit: z.number().int().nonnegative(),
  today: playgroundStorageLedgerRowSchema.optional(),
  debt_quota: z.number().int(),
  grace_until: z.number().int().nonnegative(),
  read_only: z.boolean(),
})

/**
 * The caller's read-only view of the optional metered storage tier. `today` is
 * the day still accruing (null before the first sample); `readOnly` mirrors the
 * shared wallet lock a settled-but-unpaid day triggers, and `graceUntil` is the
 * latest recorded payment deadline.
 */
export interface PlaygroundStorageBillingStatus {
  enabled: boolean
  group: string
  priceUsdPerGbMonth: number
  freeBytes: number
  applyGroupRatio: boolean
  graceDays: number
  egressMode: string
  egressPriceUsdPerGb: number
  egressDailyBytesLimit: number
  egressDailyRequestsLimit: number
  today: PlaygroundStorageToday | null
  debtQuota: number
  graceUntil: number
  readOnly: boolean
}

export interface PlaygroundStorageToday {
  peakBytes: number
  billableBytes: number
  quota: number
  debtQuota: number
  egressBytes: number
  egressRequests: number
  status: string
}

export async function getPlaygroundStorageBilling(
  signal?: AbortSignal
): Promise<PlaygroundStorageBillingStatus> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_STORAGE_BILLING, {
    signal,
  })
  requireServerSuccess(response.data)
  const status = playgroundStorageBillingSchema.parse(response.data.data)
  return {
    enabled: status.enabled,
    group: status.group,
    priceUsdPerGbMonth: status.price_usd_per_gb_month,
    freeBytes: status.free_bytes,
    applyGroupRatio: status.apply_group_ratio,
    graceDays: status.grace_days,
    egressMode: status.egress_mode,
    egressPriceUsdPerGb: status.egress_price_usd_per_gb,
    egressDailyBytesLimit: status.egress_daily_bytes_limit,
    egressDailyRequestsLimit: status.egress_daily_requests_limit,
    today: status.today
      ? {
          peakBytes: status.today.peak_bytes,
          billableBytes: status.today.billable_bytes,
          quota: status.today.quota,
          debtQuota: status.today.debt_quota,
          egressBytes: status.today.egress_bytes,
          egressRequests: status.today.egress_requests,
          status: status.today.status,
        }
      : null,
    debtQuota: status.debt_quota,
    graceUntil: status.grace_until,
    readOnly: status.read_only,
  }
}

/**
 * Server-side Playground feature switches. `sandboxPreviewEnabled` is the
 * administrator opt-in for rendering HTML/SVG artifact content inside the
 * sandboxed preview; while it is false the browser must keep artifact content
 * inert.
 */
export interface PlaygroundServerSettings {
  sandboxPreviewEnabled: boolean
}

export async function getPlaygroundSettings(
  signal?: AbortSignal
): Promise<PlaygroundServerSettings> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_SETTINGS, { signal })
  requireServerSuccess(response.data)
  const settings = playgroundSettingsSchema.parse(response.data.data)
  return { sandboxPreviewEnabled: settings.sandbox_preview_enabled }
}

const serverPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  avatar: z.string(),
  config: playgroundConfigSchema,
  parameter_enabled: parameterEnabledSchema,
  system_prompt: z.string(),
  visibility: z.enum(['private', 'global']).optional(),
  opening_message: z.string().optional(),
  suggested_questions: z.array(z.string()).optional(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

export interface PlaygroundPresetInput {
  name: string
  avatar: string
  /** Model and sampling parameters the preset applies; routing stays with the conversation. */
  config: Partial<PlaygroundConfig>
  parameter_enabled?: ParameterEnabled
  system_prompt: string
  opening_message?: string
  suggested_questions?: string[]
}

export type PlaygroundPresetUpdateInput = Partial<PlaygroundPresetInput>

export type PlaygroundPresetScope = 'private' | 'global'

export interface PlaygroundPresetListing {
  items: AssistantPreset[]
  total: number
  /** Per-account preset budget the server enforces for the owner's group. */
  limit: number
}

export interface PlaygroundPresetMarket {
  items: AssistantPreset[]
  total: number
}

function mapServerPreset(value: unknown): AssistantPreset {
  const preset = serverPresetSchema.parse(value)
  return {
    id: preset.id,
    name: preset.name,
    avatar: preset.avatar,
    config: { ...DEFAULT_CONFIG, ...preset.config },
    parameterEnabled: {
      ...DEFAULT_PARAMETER_ENABLED,
      ...preset.parameter_enabled,
    },
    systemPrompt: preset.system_prompt,
    visibility: preset.visibility ?? 'private',
    openingMessage: preset.opening_message ?? '',
    suggestedQuestions: preset.suggested_questions ?? [],
    createdAt: preset.created_at * 1000,
    updatedAt: preset.updated_at * 1000,
  }
}

export async function getPlaygroundPresets(
  signal?: AbortSignal
): Promise<PlaygroundPresetListing> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_PRESETS, { signal })
  requireServerSuccess(response.data)
  const data = z
    .object({
      items: z.array(z.unknown()),
      total: z.number().nonnegative(),
      limit: z.number().int().nonnegative(),
    })
    .parse(response.data.data)
  return {
    items: data.items.map(mapServerPreset),
    total: data.total,
    limit: data.limit,
  }
}

export async function getPlaygroundPresetMarket(
  signal?: AbortSignal
): Promise<PlaygroundPresetMarket> {
  const response = await api.get(`${API_ENDPOINTS.PLAYGROUND_PRESETS}/market`, {
    signal,
  })
  requireServerSuccess(response.data)
  const data = z
    .object({
      items: z.array(z.unknown()),
      total: z.number().nonnegative(),
    })
    .parse(response.data.data)
  return { items: data.items.map(mapServerPreset), total: data.total }
}

export async function copyPlaygroundPresetToMine(
  presetId: string,
  signal?: AbortSignal
): Promise<AssistantPreset> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_PRESETS}/market/${encodeURIComponent(presetId)}/copy`,
    undefined,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerPreset(response.data.data)
}

export async function getGlobalPlaygroundPresets(
  signal?: AbortSignal
): Promise<PlaygroundPresetMarket> {
  const response = await api.get(`${API_ENDPOINTS.PLAYGROUND_PRESETS}/global`, {
    signal,
  })
  requireServerSuccess(response.data)
  const data = z
    .object({
      items: z.array(z.unknown()),
      total: z.number().nonnegative(),
    })
    .parse(response.data.data)
  return { items: data.items.map(mapServerPreset), total: data.total }
}

export async function createPlaygroundPreset(
  input: PlaygroundPresetInput,
  signal?: AbortSignal
): Promise<AssistantPreset> {
  const response = await api.post(API_ENDPOINTS.PLAYGROUND_PRESETS, input, {
    signal,
  })
  requireServerSuccess(response.data)
  return mapServerPreset(response.data.data)
}

export async function createGlobalPlaygroundPreset(
  input: PlaygroundPresetInput,
  signal?: AbortSignal
): Promise<AssistantPreset> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_PRESETS}/global`,
    input,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerPreset(response.data.data)
}

export async function updatePlaygroundPreset(
  presetId: string,
  input: PlaygroundPresetUpdateInput,
  signal?: AbortSignal
): Promise<AssistantPreset> {
  const response = await api.patch(
    `${API_ENDPOINTS.PLAYGROUND_PRESETS}/${encodeURIComponent(presetId)}`,
    input,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerPreset(response.data.data)
}

export async function updateGlobalPlaygroundPreset(
  presetId: string,
  input: PlaygroundPresetUpdateInput,
  signal?: AbortSignal
): Promise<AssistantPreset> {
  const response = await api.patch(
    `${API_ENDPOINTS.PLAYGROUND_PRESETS}/global/${encodeURIComponent(presetId)}`,
    input,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerPreset(response.data.data)
}

export async function deletePlaygroundPreset(
  presetId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_PRESETS}/${encodeURIComponent(presetId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}

export async function deleteGlobalPlaygroundPreset(
  presetId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_PRESETS}/global/${encodeURIComponent(presetId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}

export async function exportPlaygroundPreset(
  presetId: string,
  scope: PlaygroundPresetScope = 'private',
  signal?: AbortSignal
): Promise<PlaygroundPresetExport> {
  const response = await api.get(
    scope === 'global'
      ? `${API_ENDPOINTS.PLAYGROUND_PRESETS}/global/${encodeURIComponent(presetId)}/export`
      : `${API_ENDPOINTS.PLAYGROUND_PRESETS}/${encodeURIComponent(presetId)}/export`,
    { signal }
  )
  requireServerSuccess(response.data)
  const data = z
    .object({
      format: z.literal('json'),
      filename: z.string().min(1),
      content_type: z.string().min(1),
      content: z.string(),
    })
    .parse(response.data.data)
  return {
    format: data.format,
    filename: data.filename,
    contentType: data.content_type,
    content: data.content,
  }
}

export async function importPlaygroundPreset(
  content: string,
  scope: PlaygroundPresetScope = 'private',
  signal?: AbortSignal
): Promise<AssistantPreset> {
  const path =
    scope === 'global'
      ? `${API_ENDPOINTS.PLAYGROUND_PRESETS}/global/import`
      : `${API_ENDPOINTS.PLAYGROUND_PRESETS}/import`
  const response = await api.post(path, content, {
    headers: { 'Content-Type': 'application/json' },
    signal,
  })
  requireServerSuccess(response.data)
  return mapServerPreset(response.data.data)
}

const serverSnippetSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  content: z.string(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})

export interface PlaygroundSnippetInput {
  name: string
  content: string
}

export type PlaygroundSnippetUpdateInput = Partial<PlaygroundSnippetInput>

export interface PlaygroundSnippetListing {
  items: PromptSnippet[]
  total: number
  /** Per-account snippet budget the server enforces for the owner's group. */
  limit: number
}

function mapServerSnippet(value: unknown): PromptSnippet {
  const snippet = serverSnippetSchema.parse(value)
  return {
    id: snippet.id,
    name: snippet.name,
    content: snippet.content,
    createdAt: snippet.created_at * 1000,
    updatedAt: snippet.updated_at * 1000,
  }
}

export async function getPlaygroundSnippets(
  signal?: AbortSignal
): Promise<PlaygroundSnippetListing> {
  const response = await api.get(API_ENDPOINTS.PLAYGROUND_SNIPPETS, { signal })
  requireServerSuccess(response.data)
  const data = z
    .object({
      items: z.array(z.unknown()),
      total: z.number().nonnegative(),
      limit: z.number().int().nonnegative(),
    })
    .parse(response.data.data)
  return {
    items: data.items.map(mapServerSnippet),
    total: data.total,
    limit: data.limit,
  }
}

export async function createPlaygroundSnippet(
  input: PlaygroundSnippetInput,
  signal?: AbortSignal
): Promise<PromptSnippet> {
  const response = await api.post(API_ENDPOINTS.PLAYGROUND_SNIPPETS, input, {
    signal,
  })
  requireServerSuccess(response.data)
  return mapServerSnippet(response.data.data)
}

export async function updatePlaygroundSnippet(
  snippetId: string,
  input: PlaygroundSnippetUpdateInput,
  signal?: AbortSignal
): Promise<PromptSnippet> {
  const response = await api.patch(
    `${API_ENDPOINTS.PLAYGROUND_SNIPPETS}/${encodeURIComponent(snippetId)}`,
    input,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapServerSnippet(response.data.data)
}

export async function deletePlaygroundSnippet(
  snippetId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_SNIPPETS}/${encodeURIComponent(snippetId)}`,
    { signal }
  )
  requireServerSuccess(response.data)
}
