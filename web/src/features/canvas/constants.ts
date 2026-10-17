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

export const CANVAS_DEFAULT_TITLE = 'New canvas'

export const CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS = 1000

// A new node is dropped at a small cascade near the top-left of the pane so
// repeated adds do not stack on the exact same position.
export const CANVAS_NODE_ADD_OFFSET = 32
