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
import type { PlaygroundConfig, ParameterEnabled } from './types'

// Message constants
export const MESSAGE_ROLES = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
} as const

export const MESSAGE_STATUS = {
  LOADING: 'loading',
  STREAMING: 'streaming',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const

// API endpoints
export const API_ENDPOINTS = {
  CHAT_COMPLETIONS: '/pg/chat/completions',
  IMAGE_GENERATIONS: '/pg/images/generations',
  VIDEO_GENERATIONS: '/pg/videos',
  AUDIO_SPEECH: '/pg/audio/speech',
  USER_MODELS: '/api/user/models',
  USER_GROUPS: '/api/user/self/groups',
  PLAYGROUND_SESSIONS: '/api/playground/sessions',
  PLAYGROUND_USAGE: '/api/playground/usage',
} as const

// Default group — uses 'default' as the safe fallback; auto-group is
// only selected when the backend confirms it is available for the user.
export const DEFAULT_GROUP = 'default' as const

// Default configuration
export const DEFAULT_CONFIG: PlaygroundConfig = {
  model: 'gpt-4o',
  group: DEFAULT_GROUP,
  temperature: 0.7,
  top_p: 1,
  max_tokens: 4096,
  frequency_penalty: 0,
  presence_penalty: 0,
  seed: null,
  stream: true,
}

export const DEFAULT_PARAMETER_ENABLED: ParameterEnabled = {
  temperature: true,
  top_p: true,
  max_tokens: false,
  frequency_penalty: true,
  presence_penalty: true,
  seed: false,
}

// Storage keys
export const STORAGE_KEYS = {
  CONFIG: 'playground_config',
  MESSAGES: 'playground_messages',
  PARAMETER_ENABLED: 'playground_parameter_enabled',
  SESSIONS: 'playground_sessions',
} as const

export const DEFAULT_SESSION_TITLE = 'New conversation'
export const MAX_STORED_SESSIONS = 20

// Conversation attachment limits; the server enforces the same budgets.
export const PLAYGROUND_ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif'
export const PLAYGROUND_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
export const PLAYGROUND_ATTACHMENT_MAX_COUNT = 8

// Generation entry defaults. The server validates every model and parameter
// again through the ordinary Relay/task pipeline.
export const PLAYGROUND_GENERATION_KINDS = ['image', 'video', 'audio'] as const
export const PLAYGROUND_IMAGE_SIZES = [
  '1024x1024',
  '1792x1024',
  '1024x1792',
] as const
export const PLAYGROUND_VIDEO_DURATIONS = [5, 10] as const
export const PLAYGROUND_AUDIO_VOICES = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
] as const

// Task list polling. The list refreshes only while one of the account's tasks
// is unfinished; the terminal states stop the interval.
export const PLAYGROUND_TASK_PAGE_SIZE = 20
export const PLAYGROUND_TASK_POLL_INTERVAL_MS = 5000
export const PLAYGROUND_TASK_TERMINAL_STATUSES: readonly string[] = [
  'SUCCESS',
  'FAILURE',
]

export const PLAYGROUND_GENERATION_ERRORS = {
  IMAGE_FAILED: 'Image generation failed',
  VIDEO_FAILED: 'Video generation failed',
  AUDIO_FAILED: 'Audio generation failed',
  TASK_LIST_FAILED: 'Failed to load the generation tasks',
  CANVAS_SEND_FAILED: 'Unable to send the result to the canvas',
} as const

// Error messages
export const ERROR_MESSAGES = {
  API_REQUEST_ERROR: 'Request error occurred',
  NETWORK_ERROR: 'Network connection failed or server not responding',
  PARSE_ERROR: 'Error parsing response data',
  STREAM_START_ERROR: 'Error establishing connection',
  CONNECTION_CLOSED: 'Connection closed',
  INTERRUPTED: 'Generation was interrupted',
} as const

// Message action button styles
export const MESSAGE_ACTION_BUTTON_STYLES = {
  BASE: 'size-7 text-muted-foreground hover:text-foreground',
  DELETE: 'size-7 text-muted-foreground hover:text-destructive',
  ICON: 'size-4',
} as const

// Message action labels
export const MESSAGE_ACTION_LABELS = {
  COPY: 'Copy',
  COPIED: 'Copied!',
  REGENERATE: 'Regenerate',
  SHOW_PREVIEW: 'Show preview',
  SHOW_SOURCE: 'Show source',
  EDIT: 'Edit',
  DELETE: 'Delete',
  SEND_TO_CANVAS: 'Send to canvas',
  NO_CONTENT: 'No content to copy',
  WAIT_GENERATION: 'Please wait for the current generation to complete',
} as const
