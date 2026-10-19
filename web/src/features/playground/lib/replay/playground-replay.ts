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
import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import type { ParameterEnabled, PlaygroundConfig } from '../../types'

/**
 * The replay projection the server returns for one usage log. Everything below
 * the request metadata is present only while the deployment's optional
 * Playground log capture is on and the stored copy has not expired.
 */
export interface PlaygroundLogReplaySampling {
  temperature?: number
  top_p?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
  reasoning_effort?: string
}

export interface PlaygroundLogReplayMessage {
  role?: string
  content?: unknown
}

export interface PlaygroundLogReplayStoredRequest {
  model?: string
  group?: string
  stream?: boolean
  sampling?: PlaygroundLogReplaySampling
  message_count?: number
  messages?: PlaygroundLogReplayMessage[]
  truncated?: boolean
}

export interface PlaygroundLogReplayStoredResponse {
  status?: number
  content?: string
  finish_reason?: string
  model?: string
  truncated?: boolean
}

export interface PlaygroundLogReplayCapture {
  expires_at?: number
  truncated?: boolean
  request?: PlaygroundLogReplayStoredRequest
  response?: PlaygroundLogReplayStoredResponse
}

export interface PlaygroundLogReplay {
  request_id: string
  log_id?: number
  user_id?: number
  created_at?: number
  type?: number
  model?: string
  group?: string
  stream?: boolean
  path?: string
  prompt_tokens?: number
  completion_tokens?: number
  quota?: number
  param_overrides?: string[]
  capture_enabled?: boolean
  content_available?: boolean
  content_unavailable_reason?: string
  sampling?: PlaygroundLogReplaySampling
  capture?: PlaygroundLogReplayCapture
}

/** A fresh conversation's settings plus the prompt the log left behind. */
export interface PlaygroundReplayDraft {
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  /** Last user text of the retained request; empty when none was captured. */
  text: string
  /** i18n key explaining why no content was restored, or null. */
  contentNotice: string | null
}

const REPLAY_CONTENT_CAPTURE_DISABLED_NOTICE =
  'Request content was not retained because Playground log capture is disabled. Only the request parameters were restored.'
const REPLAY_CONTENT_EXPIRED_NOTICE =
  'The retained request content has expired. Only the request parameters were restored.'
const REPLAY_CONTENT_NOT_CAPTURED_NOTICE =
  'Request content was not retained for this log. Only the request parameters were restored.'

function replayContentNoticeKey(reason: string | undefined): string {
  if (reason === 'capture_disabled')
    return REPLAY_CONTENT_CAPTURE_DISABLED_NOTICE
  if (reason === 'expired') return REPLAY_CONTENT_EXPIRED_NOTICE
  return REPLAY_CONTENT_NOT_CAPTURED_NOTICE
}

/**
 * Builds the draft a replay deep link loads: model, group, stream and every
 * sampling parameter the log or its stored summary actually recorded. A value
 * the record never held stays at the account's default and is not enabled, so
 * the draft never invents a parameter the original request did not send.
 */
export function buildPlaygroundReplayDraft(
  replay: PlaygroundLogReplay
): PlaygroundReplayDraft {
  const config: PlaygroundConfig = { ...DEFAULT_CONFIG }
  if (typeof replay.model === 'string' && replay.model.trim()) {
    config.model = replay.model.trim()
  }
  if (typeof replay.group === 'string' && replay.group.trim()) {
    config.group = replay.group.trim()
  }
  if (typeof replay.stream === 'boolean') {
    config.stream = replay.stream
  }

  const parameterEnabled: ParameterEnabled = { ...DEFAULT_PARAMETER_ENABLED }
  const sampling = replay.sampling
  if (sampling) {
    if (typeof sampling.temperature === 'number') {
      config.temperature = sampling.temperature
      parameterEnabled.temperature = true
    }
    if (typeof sampling.top_p === 'number') {
      config.top_p = sampling.top_p
      parameterEnabled.top_p = true
    }
    if (typeof sampling.max_tokens === 'number') {
      config.max_tokens = sampling.max_tokens
      parameterEnabled.max_tokens = true
    }
    if (typeof sampling.frequency_penalty === 'number') {
      config.frequency_penalty = sampling.frequency_penalty
      parameterEnabled.frequency_penalty = true
    }
    if (typeof sampling.presence_penalty === 'number') {
      config.presence_penalty = sampling.presence_penalty
      parameterEnabled.presence_penalty = true
    }
    if (typeof sampling.seed === 'number') {
      config.seed = sampling.seed
      parameterEnabled.seed = true
    }
    if (sampling.reasoning_effort) {
      config.reasoning_effort = sampling.reasoning_effort
      parameterEnabled.reasoning_effort = true
    }
  }

  // The composer gets the last user turn of the retained request, so a retry
  // starts from the same prompt. Assistant and system turns stay out of the
  // draft: the new conversation has no history to replay.
  const messages = replay.capture?.request?.messages ?? []
  let text = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (typeof message.content !== 'string') continue
    if (!message.content.trim()) continue
    text = message.content
    break
  }

  return {
    config,
    parameterEnabled,
    text,
    contentNotice: replay.content_available
      ? null
      : replayContentNoticeKey(replay.content_unavailable_reason),
  }
}
