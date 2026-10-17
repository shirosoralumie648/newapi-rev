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
  'prompt',
  'image',
  'artifact',
  'message',
  'task',
] as const

export const CANVAS_DEFAULT_TITLE = 'New canvas'

export const CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS = 1000
