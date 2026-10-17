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
import type { CanvasNodeKind, CanvasWorkflowGenerationKind } from './types'

// Mirror of the server-side canvas document contract. The server validates
// the same bounds again; the client copy keeps import and edit feedback local.
export const CANVAS_MAX_NODES = 200
export const CANVAS_MAX_EDGES = 400
export const CANVAS_DOCUMENT_MAX_BYTES = 1 << 20
export const CANVAS_NODE_DATA_MAX_BYTES = 64 << 10

export const CANVAS_AUTOSAVE_DELAY_MS = 800
export const CANVAS_HISTORY_LIMIT = 50

export const CANVAS_STORAGE_LAST_PROJECT = 'playground_canvas_last_project'

export const CANVAS_NODE_KINDS = [
  'text',
  'note',
  'prompt',
  'message',
  'attachment',
  'image',
  'artifact',
  'model',
  'task',
  'task-result',
] as const

// Translation keys for the node kinds. The values double as English source
// text and as i18n keys, so the node header always follows the interface
// language.
export const CANVAS_NODE_KIND_LABELS: Record<CanvasNodeKind, string> = {
  text: 'Text',
  note: 'Note',
  prompt: 'Prompt',
  message: 'Message',
  attachment: 'Attachment',
  image: 'Image',
  artifact: 'Artifact',
  model: 'Model call',
  task: 'Task',
  'task-result': 'Task result',
}

// Workflow run bounds. The resolved input, model output and failure summary a
// node stores stay small so a board with workflow steps keeps far below the
// server's per-node data budget; the full result bytes stay behind the relay
// and task artifact endpoints.
export const CANVAS_WORKFLOW_INPUT_MAX_CHARS = 4000
export const CANVAS_WORKFLOW_OUTPUT_MAX_CHARS = 4000
export const CANVAS_WORKFLOW_ERROR_MAX_CHARS = 500

// The media kinds a generation step can submit through the Playground relay.
export const CANVAS_WORKFLOW_GENERATIONS = ['image', 'video'] as const

// Generation configuration of a `task` step. Every value describes a request
// the relay re-validates: the count is bounded server-side by `dto.MaxImageN`,
// the duration by `relaycommon.MaxTaskDurationSeconds`, and an unknown
// size/quality is answered by the channel. The size preset carries its aspect
// ratio so one control expresses both, because the relay only forwards the
// concrete size to the provider.
export const CANVAS_WORKFLOW_IMAGE_QUALITIES = [
  'auto',
  'low',
  'medium',
  'high',
  'standard',
  'hd',
] as const
export const CANVAS_WORKFLOW_IMAGE_COUNTS = [1, 2, 3, 4] as const
export const CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS: Record<string, string> = {
  '1024x1024': '1:1',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
}
export const CANVAS_WORKFLOW_VIDEO_SIZES = [
  '1280x720',
  '720x1280',
  '1024x1024',
] as const
export const CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS: Record<string, string> = {
  '1280x720': '16:9',
  '720x1280': '9:16',
  '1024x1024': '1:1',
}

// Reference images read from connected upstream nodes. The bytes travel inside
// the request body, so the count and each image's size stay bounded; the relay
// reads and forwards the body under its own request-size limit.
export const CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT = 4
export const CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES = 8 * 1024 * 1024

// A new linked node (a result node added by a run) is dropped to the right of
// the step it belongs to.
export const CANVAS_LINKED_NODE_OFFSET_X = 340

// Mention suggestions shown while typing `@`.
export const CANVAS_WORKFLOW_MENTION_MAX_MATCHES = 8
// Mirrors `relaycommon.MaxTaskDurationSeconds` on the server: an imported
// board's duration is bounded here before it is ever sent.
export const CANVAS_WORKFLOW_DURATION_MAX_SECONDS = 3600

export const CANVAS_WORKFLOW_GENERATION_LABELS: Record<
  CanvasWorkflowGenerationKind,
  string
> = {
  image: 'Image',
  video: 'Video',
}

// Async generation steps poll the owner-scoped durable task row; terminal
// states stop the loop.
export const CANVAS_WORKFLOW_TASK_POLL_INTERVAL_MS = 5000

// Workflow problem keys the run reports. The strings double as English source
// text and as i18n keys.
export const CANVAS_WORKFLOW_MESSAGES = {
  RESULT_NODE_LIMIT: 'The canvas is full; the run could not add a result node.',
  RETRY_SOURCE_MISSING:
    'The step that produced this result is no longer on the canvas.',
  IMAGE_UNAVAILABLE: 'A connected reference image could not be read.',
  IMAGE_TOO_LARGE:
    'A connected reference image is larger than the 8 MiB limit.',
} as const

export const CANVAS_DEFAULT_TITLE = 'New canvas'

export const CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS = 1000

// A new node is dropped at a small cascade near the top-left of the pane so
// repeated adds do not stack on the exact same position.
export const CANVAS_NODE_ADD_OFFSET = 32
