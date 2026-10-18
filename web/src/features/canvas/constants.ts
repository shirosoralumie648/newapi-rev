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
import type {
  CanvasAssistantMode,
  CanvasNodeKind,
  CanvasWorkflowGenerationKind,
} from './types'

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
  'video',
  'audio',
  'group',
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
  video: 'Video',
  audio: 'Audio',
  group: 'Group',
}

// Editing operations that change the graph (copy/paste and grouping). The
// clipboard is editor-local: it never claims the system clipboard, and a paste
// always re-creates node ids so a pasted node can never collide with the one it
// was copied from.
export const CANVAS_PASTE_OFFSET = 32

// A group box is drawn around its children with this padding; the children are
// stored relative to the box, so moving the box moves them all.
export const CANVAS_GROUP_PADDING = 32
// Fallback footprint of one node while the browser has not measured it yet, so
// grouping still produces a box that contains the nodes.
export const CANVAS_NODE_ESTIMATED_WIDTH = 256
export const CANVAS_NODE_ESTIMATED_HEIGHT = 140
// Nested groups are not created by the editor (an imported board may contain
// them, so traversals stay bounded).
export const CANVAS_GROUP_MAX_DEPTH = 8

// Files dropped on the pane are uploaded into the canvas' own attachment
// partition and become one attachment node each, laid out to the right of the
// drop point. The server re-validates the same bounds.
export const CANVAS_DROP_NODE_OFFSET_X = 300
export const CANVAS_DROP_MESSAGES = {
  UNSUPPORTED_TYPE:
    'Only images, videos, audio and PDF files can be added to the canvas.',
  TOO_MANY: 'Add at most {{count}} files at a time.',
  UPLOAD_FAILED: 'The file could not be added to the canvas.',
} as const

// A small image keeps the one-request base64 path: the bytes are already primed
// for an instant preview. Everything larger goes through the reservation flow
// so the file never travels inside a JSON body.
export const CANVAS_ATTACHMENT_INLINE_MAX_BYTES = 1024 * 1024

export const CANVAS_EDIT_MESSAGES = {
  PASTE_NO_ROOM: 'The canvas is full; the selection could not be pasted.',
} as const

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

// Image tools of one image node. Crop and local upscale transform the bytes in
// the browser and save the result as a new canvas attachment; redraw sends the
// image plus a painted mask through the existing /pg/images/edits relay route,
// so billing, permissions and channel selection stay server-side. Every tool
// adds its result as a new image node linked to the node it started from.
export const CANVAS_IMAGE_TOOL_UPSCALE_FACTORS = [2, 3, 4] as const
// Longest edge of an image a tool draws or returns. It bounds the local upscale
// and the canvas a redraw composes, so a huge source cannot exhaust browser
// memory; the text of the related messages mirrors this value.
export const CANVAS_IMAGE_TOOL_MAX_EDGE = 4096
// Smallest crop edge a tool submits, in source pixels.
export const CANVAS_IMAGE_TOOL_CROP_MIN_SIZE = 8
// Brush diameters in source pixels: a fine stroke, the default and a broad one.
export const CANVAS_IMAGE_TOOL_BRUSH_SIZES = [12, 24, 48] as const

// Translation keys for the image tool dialogs. The values double as English
// source text and as i18n keys.
export const CANVAS_IMAGE_TOOL_TITLES = {
  crop: 'Crop image',
  redraw: 'Redraw image area',
  upscale: 'Upscale image',
} as const

// Image tool problem keys the hook reports. The strings double as English
// source text and as i18n keys. The size limit mirrors
// CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES, which the read path enforces.
export const CANVAS_IMAGE_TOOL_MESSAGES = {
  SOURCE_UNREADABLE: 'The image could not be read from this node.',
  SOURCE_TOO_LARGE: 'The image is larger than the 8 MiB limit.',
  CROP_TOO_SMALL: 'The crop area is too small.',
  UPSCALE_UNAVAILABLE:
    'The image cannot be upscaled within the 4096-pixel limit.',
  MASK_EMPTY: 'Paint over the area you want to change.',
  PROMPT_REQUIRED: 'Describe the change for the painted area.',
  MODEL_REQUIRED: 'Choose a model for the redraw.',
  RESULT_UNREADABLE: 'The generated image could not be added to the canvas.',
  NODE_LIMIT: 'The canvas is full; the result could not be added.',
  FAILED: 'The image operation failed.',
} as const

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
export const CANVAS_NODE_ADD_BASE = 96
export const CANVAS_NODE_ADD_OFFSET = 32

// The canvas assistant chats about the selected node and its transitive
// upstream chain. The walk is bounded in depth and node count and every node
// contributes a bounded text, so a large board cannot overshoot the relay's
// request budget; media references stay ids and never become URLs.
export const CANVAS_ASSISTANT_CONTEXT_MAX_NODES = 24
export const CANVAS_ASSISTANT_CONTEXT_MAX_DEPTH = 8
export const CANVAS_ASSISTANT_CONTEXT_NODE_MAX_CHARS = 600

// Prior turns one request replays; the panel keeps showing every message.
export const CANVAS_ASSISTANT_HISTORY_MAX_MESSAGES = 20

// One instruction is bounded like a workflow input, because an image/video
// reply reuses it as the generation step's own text.
export const CANVAS_ASSISTANT_INPUT_MAX_CHARS = 4000

export const CANVAS_ASSISTANT_MODES = ['chat', 'image', 'video'] as const

// Translation keys for the assistant modes. The values double as English
// source text and as i18n keys.
export const CANVAS_ASSISTANT_MODE_LABELS: Record<CanvasAssistantMode, string> =
  {
    chat: 'Chat',
    image: 'Image',
    video: 'Video',
  }

// Assistant problem keys the panel reports. The strings double as English
// source text and as i18n keys.
export const CANVAS_ASSISTANT_MESSAGES = {
  ANCHOR_REQUIRED: 'Select a node to generate a result from.',
  NO_MODEL: 'Choose a model for the canvas assistant.',
  REQUEST_FAILED: 'The assistant request failed.',
} as const

// Translation keys for the one action a settled reply offers per mode. The
// values double as English source text and as i18n keys.
export const CANVAS_ASSISTANT_REPLY_LABELS: Record<
  CanvasAssistantMode,
  string
> = {
  chat: 'Insert into canvas',
  image: 'Generate image',
  video: 'Generate video',
}
