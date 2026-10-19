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

import { canvasDocumentSchema } from '@/features/canvas/lib/canvas-document'
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import { API_ENDPOINTS } from './constants'
import type {
  PlaygroundSessionShare,
  PlaygroundSharedConversation,
  PlaygroundSharedTarget,
} from './types'

const shareResponseSchema = z.object({
  token: z.string(),
  url_path: z.string(),
  expires_at: z.number().nonnegative(),
  created_at: z.number().nonnegative(),
})

const sharedAttachmentSchema = z.object({
  filename: z.string().optional(),
  media_type: z.string().optional(),
})

const sharedToolCallSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'completed', 'denied', 'error']),
})

const sharedMessageSchema = z.object({
  key: z.string(),
  from: z.enum(['user', 'assistant']),
  content: z.string(),
  tool_calls: z.array(sharedToolCallSchema).optional(),
  attachments: z.array(sharedAttachmentSchema).optional(),
})

const sharedConversationSchema = z.object({
  title: z.string(),
  opening_message: z.string().optional(),
  messages: z.array(sharedMessageSchema),
})

// The canvas snapshot carries the same document contract as an owned project:
// layout, text previews and node status only. The absence of a `kind` field is
// the conversation fallback, so a response that parses as a canvas wins.
const sharedCanvasSchema = z.object({
  kind: z.literal('canvas'),
  title: z.string(),
  document: canvasDocumentSchema,
  updated_at: z.number().nonnegative().optional(),
})

function mapSharedConversation(
  conversation: z.infer<typeof sharedConversationSchema>
): PlaygroundSharedConversation {
  return {
    title: conversation.title,
    openingMessage: conversation.opening_message ?? '',
    messages: conversation.messages.map((message) => ({
      key: message.key,
      from: message.from,
      content: message.content,
      toolCalls: message.tool_calls ?? [],
      attachments: (message.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        mediaType: attachment.media_type,
      })),
    })),
  }
}

/** Create a new link for one owned conversation, revoking its previous link. */
export async function createPlaygroundSessionShare(
  sessionId: string,
  expiresInDays: number,
  signal?: AbortSignal
): Promise<PlaygroundSessionShare> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/share`,
    { expires_in_days: expiresInDays },
    { signal }
  )
  requireServerSuccess(response.data)
  const share = shareResponseSchema.parse(response.data.data)
  // The API speaks Unix seconds like the rest of the Playground contract;
  // frontend timestamps stay in milliseconds.
  return {
    token: share.token,
    urlPath: share.url_path,
    expiresAt: share.expires_at * 1000,
    createdAt: share.created_at * 1000,
  }
}

/** Revoke every active link of one owned conversation. */
export async function revokePlaygroundSessionShare(
  sessionId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_SESSIONS}/${encodeURIComponent(sessionId)}/share`,
    { signal }
  )
  requireServerSuccess(response.data)
}

/** Create a new link for one owned canvas, revoking its previous link. */
export async function createPlaygroundCanvasShare(
  canvasId: string,
  expiresInDays: number,
  signal?: AbortSignal
): Promise<PlaygroundSessionShare> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_CANVASES}/${encodeURIComponent(canvasId)}/share`,
    { expires_in_days: expiresInDays },
    { signal }
  )
  requireServerSuccess(response.data)
  const share = shareResponseSchema.parse(response.data.data)
  return {
    token: share.token,
    urlPath: share.url_path,
    expiresAt: share.expires_at * 1000,
    createdAt: share.created_at * 1000,
  }
}

/** Revoke every active link of one owned canvas. */
export async function revokePlaygroundCanvasShare(
  canvasId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.delete(
    `${API_ENDPOINTS.PLAYGROUND_CANVASES}/${encodeURIComponent(canvasId)}/share`,
    { signal }
  )
  requireServerSuccess(response.data)
}

/**
 * Read one anonymous share. The response is already a sanitized snapshot: it
 * contains text, tool-call summaries and attachment labels only.
 */
export async function getSharedPlaygroundConversation(
  token: string,
  signal?: AbortSignal
): Promise<PlaygroundSharedConversation> {
  const response = await api.get(
    `${API_ENDPOINTS.PLAYGROUND_SHARED}/${encodeURIComponent(token)}`,
    { signal }
  )
  requireServerSuccess(response.data)
  return mapSharedConversation(
    sharedConversationSchema.parse(response.data.data)
  )
}

/**
 * Read one anonymous share of either kind. A canvas snapshot carries a
 * `document`; anything else is the conversation contract, which keeps links
 * created before canvas sharing existed working unchanged. Neither branch
 * contains ids, provider URLs, inputs, errors or fetchable media references.
 */
export async function getSharedPlaygroundTarget(
  token: string,
  signal?: AbortSignal
): Promise<PlaygroundSharedTarget> {
  const response = await api.get(
    `${API_ENDPOINTS.PLAYGROUND_SHARED}/${encodeURIComponent(token)}`,
    { signal }
  )
  requireServerSuccess(response.data)
  const canvas = sharedCanvasSchema.safeParse(response.data.data)
  if (canvas.success) {
    return {
      kind: 'canvas',
      canvas: {
        title: canvas.data.title,
        updatedAt: (canvas.data.updated_at ?? 0) * 1000,
        document: canvas.data.document,
      },
    }
  }
  return {
    kind: 'conversation',
    conversation: mapSharedConversation(
      sharedConversationSchema.parse(response.data.data)
    ),
  }
}
