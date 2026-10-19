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

import { API_ENDPOINTS } from './constants'
import type {
  PlaygroundSessionShare,
  PlaygroundSharedConversation,
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
  const conversation = sharedConversationSchema.parse(response.data.data)
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
