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
  PlaygroundServerSession,
} from './types'

/**
 * Send chat completion request (non-streaming)
 */
export async function sendChatCompletion(
  payload: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const res = await api.post(API_ENDPOINTS.CHAT_COMPLETIONS, payload, {
    signal,
    skipErrorHandler: true,
  } as Record<string, unknown>)
  return res.data
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

function mapMessageSnapshot(value: unknown): PlaygroundMessageSnapshot {
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
      data.messages.map((message) => message.payload)
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
  return mapMessageSnapshot(response.data.data)
}

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
  return mapMessageSnapshot(response.data.data)
}
