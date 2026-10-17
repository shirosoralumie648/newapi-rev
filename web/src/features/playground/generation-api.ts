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

import { API_ENDPOINTS } from './constants'

/** One image the relay returned, either as a URL or as inline Base64. */
export interface PlaygroundImageResult {
  url?: string
  b64Json?: string
}

export interface PlaygroundImageGenerationInput {
  model: string
  prompt: string
  group: string
  size?: string
}

export interface PlaygroundVideoGenerationInput {
  model: string
  prompt: string
  group: string
  duration?: number
}

export interface PlaygroundAudioSpeechInput {
  model: string
  text: string
  group: string
  voice: string
}

const imageGenerationSchema = z.object({
  data: z.array(
    z.object({
      url: z.string().optional(),
      b64_json: z.string().optional(),
    })
  ),
})

const videoTaskSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().optional(),
})

/**
 * Starts an image generation through the Playground relay route. The body
 * carries the workspace group so the server applies the same group override
 * the chat workspace uses; channel selection, permissions and billing are the
 * ordinary relay pipeline, never a browser-held API key.
 */
export async function submitImageGeneration(
  input: PlaygroundImageGenerationInput,
  signal?: AbortSignal
): Promise<PlaygroundImageResult[]> {
  const response = await api.post(
    API_ENDPOINTS.IMAGE_GENERATIONS,
    {
      model: input.model,
      prompt: input.prompt,
      group: input.group,
      ...(input.size ? { size: input.size } : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const parsed = imageGenerationSchema.safeParse(response.data)
  if (!parsed.success) {
    throw new Error('Image generation failed')
  }
  return parsed.data.data.map((item) => ({
    ...(item.url ? { url: item.url } : {}),
    ...(item.b64_json ? { b64Json: item.b64_json } : {}),
  }))
}

/**
 * Submits a video generation task and returns its public task id when the
 * response carries one. An empty id is not a failure: the task list polls the
 * account's durable task rows, which is the authoritative status source.
 */
export async function submitVideoGeneration(
  input: PlaygroundVideoGenerationInput,
  signal?: AbortSignal
): Promise<string> {
  const response = await api.post(
    API_ENDPOINTS.VIDEO_GENERATIONS,
    {
      model: input.model,
      prompt: input.prompt,
      group: input.group,
      ...(input.duration && input.duration > 0
        ? { duration: input.duration }
        : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const parsed = videoTaskSchema.safeParse(response.data)
  if (!parsed.success) return ''
  return parsed.data.task_id ?? parsed.data.id ?? ''
}

/**
 * Generates speech through the Playground audio route. The relay returns the
 * audio bytes themselves, so the panel plays them from an object URL.
 */
export async function submitAudioSpeech(
  input: PlaygroundAudioSpeechInput,
  signal?: AbortSignal
): Promise<Blob> {
  const response = await api.post(
    API_ENDPOINTS.AUDIO_SPEECH,
    {
      model: input.model,
      input: input.text,
      voice: input.voice,
      group: input.group,
    },
    { signal, responseType: 'blob', skipErrorHandler: true }
  )
  return response.data as Blob
}
