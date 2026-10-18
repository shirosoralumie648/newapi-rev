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
  PLAYGROUND_IMAGE_MAX_COUNT,
  PLAYGROUND_VIDEO_MAX_DURATION_SECONDS,
} from './constants'

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
  quality?: string
  /** Requested image count (the relay `n`); a bounded billing multiplier. */
  count?: number
  /** Reference image URLs or data URLs read from connected resources. */
  images?: string[]
}

export interface PlaygroundVideoGenerationInput {
  model: string
  prompt: string
  group: string
  duration?: number
  size?: string
  /** Reference images for an image-to-video submission. */
  images?: string[]
}

export interface PlaygroundAudioSpeechInput {
  model: string
  text: string
  group: string
  voice: string
}

export interface PlaygroundAudioTranscriptionInput {
  model: string
  group: string
  /** Recorded clip; the relay forwards it to the transcription model as-is. */
  file: Blob
  filename: string
}

const imageGenerationSchema = z.object({
  data: z.array(
    z.object({
      url: z.string().optional(),
      b64_json: z.string().optional(),
    })
  ),
})

const imageTaskSchema = z.object({
  success: z.literal(true),
  data: z.object({ task_id: z.string().min(1) }),
})

const videoTaskSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().optional(),
})

/**
 * Keeps a user-supplied billing multiplier inside the bound the server
 * enforces (`dto.MaxImageN`); anything malformed is dropped instead of sent.
 */
function boundedImageCount(count: number | undefined): number | undefined {
  if (count === undefined) return undefined
  if (!Number.isInteger(count)) return undefined
  if (count < 1 || count > PLAYGROUND_IMAGE_MAX_COUNT) return undefined
  return count
}

/** Same guard for a duration, mirroring `relaycommon.MaxTaskDurationSeconds`. */
function boundedDurationSeconds(
  duration: number | undefined
): number | undefined {
  if (duration === undefined) return undefined
  if (!Number.isInteger(duration)) return undefined
  if (duration < 1 || duration > PLAYGROUND_VIDEO_MAX_DURATION_SECONDS) {
    return undefined
  }
  return duration
}

/**
 * One image generation either answered with its images inside the response or
 * became a durable task whose result the task list and its stored artifacts
 * carry. A model served by a task plugin (a long-running upstream image job)
 * answers with the task id, so the browser never waits through a proxy timeout.
 */
export type PlaygroundImageGenerationOutcome =
  | { kind: 'images'; images: PlaygroundImageResult[] }
  | { kind: 'task'; taskId: string }

/**
 * Starts an image generation through the Playground relay route. The body
 * carries the workspace group so the server applies the same group override
 * the chat workspace uses; channel selection, permissions and billing are the
 * ordinary relay pipeline, never a browser-held API key.
 */
export async function submitImageGeneration(
  input: PlaygroundImageGenerationInput,
  signal?: AbortSignal
): Promise<PlaygroundImageGenerationOutcome> {
  const count = boundedImageCount(input.count)
  const images = (input.images ?? []).filter(Boolean)
  const response = await api.post(
    API_ENDPOINTS.IMAGE_GENERATIONS,
    {
      model: input.model,
      prompt: input.prompt,
      group: input.group,
      ...(input.size ? { size: input.size } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(count ? { n: count } : {}),
      ...(images.length > 0 ? { images } : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const task = imageTaskSchema.safeParse(response.data)
  if (task.success) {
    return { kind: 'task', taskId: task.data.data.task_id }
  }
  const parsed = imageGenerationSchema.safeParse(response.data)
  if (!parsed.success) {
    throw new Error('Image generation failed')
  }
  return {
    kind: 'images',
    images: parsed.data.data.map((item) => ({
      ...(item.url ? { url: item.url } : {}),
      ...(item.b64_json ? { b64Json: item.b64_json } : {}),
    })),
  }
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
  const duration = boundedDurationSeconds(input.duration)
  const images = (input.images ?? []).filter(Boolean)
  const response = await api.post(
    API_ENDPOINTS.VIDEO_GENERATIONS,
    {
      model: input.model,
      prompt: input.prompt,
      group: input.group,
      ...(duration ? { duration } : {}),
      ...(input.size ? { size: input.size } : {}),
      ...(images.length > 0 ? { images } : {}),
    },
    { signal, skipErrorHandler: true }
  )
  const parsed = videoTaskSchema.safeParse(response.data)
  if (!parsed.success) return ''
  return parsed.data.task_id ?? parsed.data.id ?? ''
}

/**
 * Cancels one unfinished workspace generation task. The server guards the
 * transition with a status CAS, so a task that finished meanwhile answers with
 * the stable not-cancelable error instead of overwriting its result.
 */
export async function cancelPlaygroundTask(
  taskId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await api.post(
    `${API_ENDPOINTS.PLAYGROUND_TASKS}/${encodeURIComponent(taskId)}/cancel`,
    {},
    { signal, skipErrorHandler: true }
  )
  requireServerSuccess(response.data)
}

/**
 * Keeps or releases one stored generation result. The server enforces
 * ownership, the workspace origin, and the finished task state; a pinned
 * result is exempt from the result retention window.
 */
export async function setPlaygroundTaskArtifactPin(
  taskId: string,
  artifactKey: string,
  pinned: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  const response = await api.put(
    `${API_ENDPOINTS.PLAYGROUND_TASKS}/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactKey)}/pin`,
    { pinned },
    { signal, skipErrorHandler: true }
  )
  const body = requireServerSuccess(response.data) as {
    data?: { pinned?: unknown }
  }
  return body.data?.pinned === true
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

const audioTranscriptionSchema = z.object({
  text: z.string(),
})

/**
 * Transcribes one recorded clip through the Playground transcription bridge.
 * The request is multipart, so the workspace group travels in the
 * X-Playground-Group header: the server consumes and validates it before the
 * canonical relay request, and it never reaches the upstream provider.
 */
export async function submitAudioTranscription(
  input: PlaygroundAudioTranscriptionInput,
  signal?: AbortSignal
): Promise<string> {
  const form = new FormData()
  form.append('model', input.model)
  form.append('file', input.file, input.filename)
  const response = await api.post(API_ENDPOINTS.AUDIO_TRANSCRIPTIONS, form, {
    signal,
    skipErrorHandler: true,
    headers: { 'X-Playground-Group': input.group },
  })
  const parsed = audioTranscriptionSchema.safeParse(response.data)
  if (!parsed.success) {
    throw new Error('Transcription failed')
  }
  return parsed.data.text
}
