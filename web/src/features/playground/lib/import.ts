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
import { nanoid } from 'nanoid'
import { z } from 'zod'

import {
  applyPlaygroundMessagesDelta,
  createPlaygroundSession,
  deletePlaygroundSession,
  getPlaygroundAttachmentContent,
  playgroundAttachmentContentUrl,
} from '../api'
import {
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  PLAYGROUND_ATTACHMENT_MAX_COUNT,
  PLAYGROUND_IMPORTED_ATTACHMENT_UNAVAILABLE,
} from '../constants'
import type {
  Message,
  MessageAttachment,
  MessageToolCall,
  MessageVersion,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  PlaygroundSession,
} from '../types'
import { blobToDataUrl, primePlaygroundAttachment } from './attachment-store'
import {
  uploadPlaygroundAttachmentDirect,
  uploadPlaygroundSpeechAttachment,
} from './attachment-upload'
import {
  normalizeContextSettings,
  normalizeContextSummary,
} from './context/playground-context'
import {
  messagesSchema,
  parameterEnabledSchema,
  playgroundConfigSchema,
} from './storage/storage-schema'

const EXPORTED_MESSAGE_MAX_COUNT = 2000
const EXPORTED_VERSION_MAX_COUNT = 64
// One export may reference this many files in total. The server keeps the
// authoritative per-message and per-account quotas; the local ceiling only
// stops a crafted file from starting an unbounded download loop.
const EXPORTED_ATTACHMENT_MAX_TOTAL = 400

const exportedAttachmentSchema = z.object({
  id: z.string().min(1).max(200),
  media_type: z.string().max(200).optional(),
  mediaType: z.string().max(200).optional(),
  filename: z.string().max(255).optional(),
  byte_size: z.number().int().nonnegative().optional(),
  byteSize: z.number().int().nonnegative().optional(),
})

const exportedToolCallSchema = z.object({
  id: z.string().max(500),
  name: z.string().max(500),
  arguments: z.string(),
  status: z.enum(['pending', 'completed', 'denied', 'error']),
  result: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number().optional(),
  completedAt: z.number().optional(),
})

const exportedVersionSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string(),
  model: z.string().max(512).optional(),
  status: z.string().max(32).optional(),
  errorCode: z.string().max(500).nullish(),
  attachments: z
    .array(exportedAttachmentSchema)
    .max(PLAYGROUND_ATTACHMENT_MAX_COUNT)
    .optional(),
  speech: exportedAttachmentSchema.nullish(),
  toolCalls: z.array(exportedToolCallSchema).max(64).optional(),
  finishReason: z.string().max(64).optional(),
})

const exportedSourceSchema = z.object({
  href: z.string().max(4096),
  title: z.string().max(500),
})

const exportedReasoningSchema = z.object({
  content: z.string(),
  duration: z.number().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
})

const exportedMessageSchema = z.object({
  key: z.string().min(1).max(200),
  from: z.enum(['user', 'assistant', 'system']),
  versions: z
    .array(exportedVersionSchema)
    .min(1)
    .max(EXPORTED_VERSION_MAX_COUNT),
  parallel: z.boolean().optional(),
  activeVersionIndex: z.number().int().nonnegative().optional(),
  createdAt: z.number().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  durationMs: z.number().optional(),
  sources: z.array(exportedSourceSchema).max(100).optional(),
  reasoning: exportedReasoningSchema.nullish(),
  isReasoningStreaming: z.boolean().optional(),
  isReasoningComplete: z.boolean().optional(),
  isContentComplete: z.boolean().optional(),
  status: z.string().max(32).optional(),
  errorCode: z.string().max(500).nullish(),
})

const exportedDocumentSchema = z.object({
  exported_at: z.number().optional(),
  session: z.object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(200),
    system_prompt: z
      .string()
      .max(64 << 10)
      .optional(),
    config: z.unknown().optional(),
    parameter_enabled: z.unknown().optional(),
    context: z.unknown().optional(),
    context_summary: z.unknown().optional(),
  }),
  messages: z
    .array(
      z.object({ client_key: z.string().optional(), payload: z.unknown() })
    )
    .max(EXPORTED_MESSAGE_MAX_COUNT),
})

/**
 * A parsed and normalized conversation export. Attachment references still
 * point at the exporting conversation: the bytes are resolved through the
 * owner-scoped content route while the conversation is rebuilt.
 */
export interface PlaygroundImportDocument {
  title: string
  sourceSessionId: string
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  systemPrompt: string
  context: PlaygroundContextSettings
  contextSummary: PlaygroundContextSummary | null
  messages: Message[]
}

export interface PlaygroundImportResult {
  session: PlaygroundSession
  /** Attachments whose bytes were not reachable and got a text placeholder. */
  unavailableAttachments: number
}

class InvalidConversationExportError extends Error {
  constructor() {
    super('Invalid conversation export.')
    this.name = 'InvalidConversationExportError'
  }
}

function normalizeExportedAttachment(value: unknown): MessageAttachment | null {
  const parsed = exportedAttachmentSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data
  const mediaType = (data.media_type || data.mediaType || '').trim()
  const byteSize = data.byte_size ?? data.byteSize
  return {
    id: data.id,
    url: '',
    mediaType: mediaType || 'application/octet-stream',
    ...(data.filename ? { filename: data.filename } : {}),
    ...(byteSize !== undefined ? { byteSize } : {}),
  }
}

function normalizeExportedToolCall(value: unknown): MessageToolCall | null {
  const parsed = exportedToolCallSchema.safeParse(value)
  if (!parsed.success || !parsed.data.id || !parsed.data.name) return null
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    arguments: parsed.data.arguments,
    status: parsed.data.status,
    ...(parsed.data.result !== undefined ? { result: parsed.data.result } : {}),
    ...(parsed.data.errorMessage !== undefined
      ? { errorMessage: parsed.data.errorMessage }
      : {}),
    ...(parsed.data.createdAt !== undefined
      ? { createdAt: parsed.data.createdAt }
      : {}),
    ...(parsed.data.completedAt !== undefined
      ? { completedAt: parsed.data.completedAt }
      : {}),
  }
}

function normalizeExportedVersion(value: unknown): MessageVersion | null {
  const parsed = exportedVersionSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data
  const attachments = (data.attachments ?? [])
    .map(normalizeExportedAttachment)
    .filter(
      (attachment): attachment is MessageAttachment => attachment !== null
    )
  const speech = data.speech ? normalizeExportedAttachment(data.speech) : null
  const toolCalls = (data.toolCalls ?? [])
    .map(normalizeExportedToolCall)
    .filter((toolCall): toolCall is MessageToolCall => toolCall !== null)
  // A pending comparison version cannot resume after an import, so the stored
  // lifecycle degrades to its settled meaning: an error stays an error.
  const status = data.status === 'error' ? 'error' : undefined

  return {
    id: data.id,
    content: data.content,
    ...(data.model ? { model: data.model } : {}),
    ...(status ? { status } : {}),
    ...(data.errorCode ? { errorCode: data.errorCode } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(speech ? { speech } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(data.finishReason ? { finishReason: data.finishReason } : {}),
  }
}

function normalizeExportedMessage(value: unknown): Message | null {
  const parsed = exportedMessageSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data
  const versions = data.versions
    .map(normalizeExportedVersion)
    .filter((version): version is MessageVersion => version !== null)
  if (versions.length === 0) return null

  const activeVersionIndex =
    data.activeVersionIndex !== undefined &&
    data.activeVersionIndex >= 0 &&
    data.activeVersionIndex < versions.length
      ? data.activeVersionIndex
      : undefined
  const parallel =
    data.parallel === true &&
    versions.length >= 2 &&
    versions.every((version) => Boolean(version.model))
      ? true
      : undefined
  let status: Message['status']
  if (data.status === 'error' || data.status === 'complete') {
    status = data.status
  } else if (data.status === 'loading' || data.status === 'streaming') {
    // A pending reply cannot resume after an import; it settles as complete.
    status = 'complete'
  }

  const message: Message = {
    key: data.key,
    from: data.from,
    versions,
    ...(parallel ? { parallel } : {}),
    ...(activeVersionIndex !== undefined ? { activeVersionIndex } : {}),
    ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
    ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
    ...(data.completedAt !== undefined
      ? { completedAt: data.completedAt }
      : {}),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    ...(data.sources && data.sources.length > 0
      ? { sources: data.sources }
      : {}),
    ...(data.reasoning
      ? {
          reasoning: {
            content: data.reasoning.content,
            duration: data.reasoning.duration ?? 0,
            ...(data.reasoning.startedAt !== undefined
              ? { startedAt: data.reasoning.startedAt }
              : {}),
            ...(data.reasoning.completedAt !== undefined
              ? { completedAt: data.reasoning.completedAt }
              : {}),
            ...(data.reasoning.durationMs !== undefined
              ? { durationMs: data.reasoning.durationMs }
              : {}),
          },
        }
      : {}),
    ...(data.isReasoningStreaming !== undefined
      ? { isReasoningStreaming: data.isReasoningStreaming }
      : {}),
    ...(data.isReasoningComplete !== undefined
      ? { isReasoningComplete: data.isReasoningComplete }
      : {}),
    ...(data.isContentComplete !== undefined
      ? { isContentComplete: data.isContentComplete }
      : {}),
    ...(status ? { status } : {}),
    ...(data.errorCode ? { errorCode: data.errorCode } : {}),
  }

  // The same schema the local store uses validates the snapshot; an unsupported
  // shape is rejected as an invalid export instead of imported partially.
  if (!messagesSchema.safeParse([message]).success) return null
  if (message.key.length > 200) return null
  return message
}

function mapExportedContextSettings(value: unknown): PlaygroundContextSettings {
  if (!value || typeof value !== 'object') return normalizeContextSettings(null)
  const source = value as Record<string, unknown>
  return normalizeContextSettings({
    historyLimit: source.history_limit,
    tokenBudget: source.token_budget,
    autoSummarize: source.auto_summarize,
    summaryModel: source.summary_model,
  })
}

function mapExportedContextSummary(
  value: unknown
): PlaygroundContextSummary | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  // The compression node is rebuilt without the exporting account's request
  // id or usage: those label a consume log the imported copy never had.
  return normalizeContextSummary({
    id: source.id,
    content: source.content,
    throughMessageKey: source.through_message_key,
    messageCount: source.message_count,
    model: source.model,
    createdAt: source.created_at,
  })
}

/**
 * Parse one conversation export produced by the host's JSON renderer. The
 * document carries attachment references only, so every message is normalized
 * to the local message contract and validated with the same schema the local
 * store uses.
 */
export function parsePlaygroundSessionExport(
  value: unknown
): PlaygroundImportDocument {
  const parsed = exportedDocumentSchema.safeParse(value)
  if (!parsed.success) {
    throw new InvalidConversationExportError()
  }
  const document = parsed.data
  const seenKeys = new Set<string>()
  const messages: Message[] = []
  let attachmentTotal = 0
  for (const entry of document.messages) {
    const message = normalizeExportedMessage(entry.payload)
    if (!message || seenKeys.has(message.key)) {
      throw new InvalidConversationExportError()
    }
    if (entry.client_key !== undefined && entry.client_key !== message.key) {
      throw new InvalidConversationExportError()
    }
    for (const version of message.versions) {
      attachmentTotal +=
        (version.attachments?.length ?? 0) + (version.speech ? 1 : 0)
    }
    if (attachmentTotal > EXPORTED_ATTACHMENT_MAX_TOTAL) {
      throw new InvalidConversationExportError()
    }
    seenKeys.add(message.key)
    messages.push(message)
  }

  const config = playgroundConfigSchema.safeParse(document.session.config ?? {})
  const parameterEnabled = parameterEnabledSchema.safeParse(
    document.session.parameter_enabled ?? {}
  )
  if (!config.success || !parameterEnabled.success) {
    throw new InvalidConversationExportError()
  }

  const title = document.session.title.trim()
  if (!title) throw new InvalidConversationExportError()

  return {
    title,
    sourceSessionId: document.session.id,
    config: { ...DEFAULT_CONFIG, ...config.data },
    parameterEnabled: {
      ...DEFAULT_PARAMETER_ENABLED,
      ...parameterEnabled.data,
    },
    systemPrompt: document.session.system_prompt ?? '',
    context: mapExportedContextSettings(document.session.context),
    contextSummary: mapExportedContextSummary(document.session.context_summary),
    messages,
  }
}

function attachmentPlaceholder(attachment: MessageAttachment): string {
  const name = attachment.filename || attachment.id
  return PLAYGROUND_IMPORTED_ATTACHMENT_UNAVAILABLE.replace('{{name}}', name)
}

function attachmentReference(
  partitionId: string,
  attachment: {
    id: string
    mediaType: string
    filename?: string
    byteSize?: number
  }
): MessageAttachment {
  return {
    id: attachment.id,
    url: playgroundAttachmentContentUrl(partitionId, attachment.id),
    mediaType: attachment.mediaType,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(attachment.byteSize !== undefined
      ? { byteSize: attachment.byteSize }
      : {}),
  }
}

interface ImportedAttachmentSource {
  id: string
  mediaType: string
  filename: string
  byteSize?: number
}

/**
 * Rebuild one exported conversation on the server: create the session through
 * the ordinary create route, re-upload every attachment the importing account
 * can still read through the owner-scoped content route (same-account import),
 * then write every message through the ordinary message chain. Attachments of
 * another account are unreachable by design and keep a text placeholder, and a
 * failed write removes the freshly created session instead of leaving a
 * half-imported copy.
 */
export async function importPlaygroundSessionDocument(
  document: PlaygroundImportDocument,
  signal?: AbortSignal
): Promise<PlaygroundImportResult> {
  const sources = new Map<string, ImportedAttachmentSource>()
  const speechIds = new Set<string>()
  for (const message of document.messages) {
    for (const version of message.versions) {
      for (const attachment of version.attachments ?? []) {
        if (!sources.has(attachment.id)) {
          sources.set(attachment.id, {
            id: attachment.id,
            mediaType: attachment.mediaType,
            filename: attachment.filename ?? attachment.id,
            byteSize: attachment.byteSize,
          })
        }
      }
      if (version.speech) {
        speechIds.add(version.speech.id)
        if (!sources.has(version.speech.id)) {
          sources.set(version.speech.id, {
            id: version.speech.id,
            mediaType: version.speech.mediaType,
            filename: version.speech.filename ?? version.speech.id,
            byteSize: version.speech.byteSize,
          })
        }
      }
    }
  }

  const blobs = new Map<string, Blob>()
  const pendingSources = [...sources.values()]
  // Bounded batches keep a large export from opening hundreds of content
  // requests at once while still resolving independent files in parallel.
  for (let index = 0; index < pendingSources.length; index += 6) {
    await Promise.all(
      pendingSources.slice(index, index + 6).map(async (source) => {
        try {
          const blob = await getPlaygroundAttachmentContent(
            playgroundAttachmentContentUrl(document.sourceSessionId, source.id),
            signal
          )
          blobs.set(source.id, blob)
        } catch {
          // The bytes are gone or belong to another account; the reference
          // degrades to a placeholder below instead of failing the import.
        }
      })
    )
  }

  const localId = nanoid()
  const created = await createPlaygroundSession(
    {
      client_id: localId,
      title: document.title,
      config: document.config,
      parameter_enabled: document.parameterEnabled,
      system_prompt: document.systemPrompt,
      context: document.context,
      context_summary: document.contextSummary,
    },
    signal
  )

  let unavailableAttachments = 0
  try {
    const uploaded = new Map<string, MessageAttachment>()
    for (const [id, blob] of blobs) {
      const source = sources.get(id)
      if (!source) continue
      if (speechIds.has(id)) {
        // Cached read-aloud audio re-uploads through the same speech path the
        // workspace uses, so the version keeps a playable reference.
        uploaded.set(
          id,
          await uploadPlaygroundSpeechAttachment(created.id, blob)
        )
        continue
      }
      // A stored filename is display text; the upload needs a bare file name.
      const filename =
        source.filename.split(/[\\/]/).pop()?.trim() || 'attachment'
      const file = new File([blob], filename, {
        type: source.mediaType || blob.type || 'application/octet-stream',
      })
      const attachment = await uploadPlaygroundAttachmentDirect(
        { sessionId: created.id },
        file,
        signal
      )
      uploaded.set(
        id,
        attachmentReference(created.id, {
          id: attachment.id,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
          byteSize: attachment.byteSize,
        })
      )
      await blobToDataUrl(blob)
        .then((dataUrl) => primePlaygroundAttachment(attachment.id, dataUrl))
        .catch(() => undefined)
    }

    const messages = document.messages.map((message) => {
      const versions = message.versions.map((version) => {
        const unavailable = (version.attachments ?? []).filter(
          (attachment) => !uploaded.has(attachment.id)
        )
        unavailableAttachments += unavailable.length
        const attachments = (version.attachments ?? [])
          .map((attachment) => uploaded.get(attachment.id))
          .filter(
            (attachment): attachment is MessageAttachment =>
              attachment !== undefined
          )
        const speech = version.speech
          ? uploaded.get(version.speech.id)
          : undefined
        const content = [version.content.trimEnd()]
          .concat(unavailable.map(attachmentPlaceholder))
          .filter((part) => part.trim() !== '')
          .join('\n\n')
        const normalized: MessageVersion = { ...version, content }
        if (attachments.length > 0) {
          normalized.attachments = attachments
        } else {
          delete normalized.attachments
        }
        if (speech) {
          normalized.speech = speech
        } else {
          delete normalized.speech
        }
        return normalized
      })
      return { ...message, versions }
    })

    const revision =
      messages.length > 0
        ? await applyPlaygroundMessagesDelta(
            created.id,
            { upserts: messages, deletes: [] },
            created.messageRevision,
            signal
          )
        : created.messageRevision

    const now = Date.now()
    return {
      unavailableAttachments,
      session: {
        id: localId,
        title: created.title,
        createdAt: now,
        updatedAt: now,
        config: document.config,
        parameterEnabled: document.parameterEnabled,
        systemPrompt: document.systemPrompt,
        context: document.context,
        contextSummary: document.contextSummary,
        messages,
        server: {
          id: created.id,
          revision: created.revision,
          messageRevision: revision,
        },
        syncPending: false,
      },
    }
  } catch (error) {
    await deletePlaygroundSession(created.id).catch(() => undefined)
    throw error
  }
}
