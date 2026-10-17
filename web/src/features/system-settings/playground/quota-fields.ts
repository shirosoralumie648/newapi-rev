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
import { safeJsonParse } from '../utils/json-parser'

// These keys must mirror the JSON tags of playground_setting.PlaygroundQuotaPolicy.
export const PLAYGROUND_QUOTA_FIELD_KEYS = [
  'session_max_count',
  'message_max_count',
  'message_max_versions',
  'message_max_bytes',
  'tool_call_max_count',
  'tool_call_arguments_max_bytes',
  'tool_call_result_max_bytes',
  'attachment_max_count',
  'attachment_max_file_bytes',
  'attachment_user_max_count',
  'attachment_user_max_bytes',
  'artifact_session_max_count',
  'artifact_session_max_records',
  'artifact_max_versions',
  'artifact_content_max_bytes',
  'artifact_max_bytes',
  'artifact_session_max_bytes',
  'artifact_user_max_count',
  'artifact_user_max_bytes',
  'canvas_user_max_projects',
  'canvas_document_max_bytes',
  'canvas_max_nodes',
  'canvas_max_edges',
  'canvas_node_data_max_bytes',
  'canvas_user_max_bytes',
  'task_max_concurrency',
  'task_user_result_max_bytes',
] as const

export type PlaygroundQuotaFieldKey =
  (typeof PLAYGROUND_QUOTA_FIELD_KEYS)[number]

export const PLAYGROUND_QUOTA_GROUPS = [
  { id: 'conversations', labelKey: 'Conversations' },
  { id: 'messages', labelKey: 'Messages' },
  { id: 'tools', labelKey: 'Tool calls' },
  { id: 'attachments', labelKey: 'Attachments' },
  { id: 'artifacts', labelKey: 'Artifacts' },
  { id: 'canvas', labelKey: 'Canvas' },
  { id: 'tasks', labelKey: 'Tasks' },
] as const

export type PlaygroundQuotaGroupId =
  (typeof PLAYGROUND_QUOTA_GROUPS)[number]['id']

type PlaygroundQuotaField = {
  key: PlaygroundQuotaFieldKey
  group: PlaygroundQuotaGroupId
  labelKey: string
  bytes?: boolean
}

export const PLAYGROUND_QUOTA_FIELDS: readonly PlaygroundQuotaField[] = [
  {
    key: 'session_max_count',
    group: 'conversations',
    labelKey: 'Conversations per user',
  },
  {
    key: 'message_max_count',
    group: 'messages',
    labelKey: 'Messages per conversation',
  },
  {
    key: 'message_max_versions',
    group: 'messages',
    labelKey: 'Message versions per message',
  },
  {
    key: 'message_max_bytes',
    group: 'messages',
    labelKey: 'Message snapshot bytes per conversation',
    bytes: true,
  },
  {
    key: 'tool_call_max_count',
    group: 'tools',
    labelKey: 'Tool calls per message version',
  },
  {
    key: 'tool_call_arguments_max_bytes',
    group: 'tools',
    labelKey: 'Tool call arguments size limit',
    bytes: true,
  },
  {
    key: 'tool_call_result_max_bytes',
    group: 'tools',
    labelKey: 'Tool call result size limit',
    bytes: true,
  },
  {
    key: 'attachment_max_count',
    group: 'attachments',
    labelKey: 'Attachments per message',
  },
  {
    key: 'attachment_max_file_bytes',
    group: 'attachments',
    labelKey: 'Attachment file size limit',
    bytes: true,
  },
  {
    key: 'attachment_user_max_count',
    group: 'attachments',
    labelKey: 'Attachments per user',
  },
  {
    key: 'attachment_user_max_bytes',
    group: 'attachments',
    labelKey: 'Attachment storage per user',
    bytes: true,
  },
  {
    key: 'artifact_session_max_count',
    group: 'artifacts',
    labelKey: 'Active artifacts per conversation',
  },
  {
    key: 'artifact_session_max_records',
    group: 'artifacts',
    labelKey: 'Artifact records per conversation',
  },
  {
    key: 'artifact_max_versions',
    group: 'artifacts',
    labelKey: 'Versions per artifact',
  },
  {
    key: 'artifact_content_max_bytes',
    group: 'artifacts',
    labelKey: 'Artifact content size limit',
    bytes: true,
  },
  {
    key: 'artifact_max_bytes',
    group: 'artifacts',
    labelKey: 'Artifact size limit',
    bytes: true,
  },
  {
    key: 'artifact_session_max_bytes',
    group: 'artifacts',
    labelKey: 'Artifact storage per conversation',
    bytes: true,
  },
  {
    key: 'artifact_user_max_count',
    group: 'artifacts',
    labelKey: 'Artifacts per user',
  },
  {
    key: 'artifact_user_max_bytes',
    group: 'artifacts',
    labelKey: 'Artifact storage per user',
    bytes: true,
  },
  {
    key: 'canvas_user_max_projects',
    group: 'canvas',
    labelKey: 'Canvas projects per user',
  },
  {
    key: 'canvas_document_max_bytes',
    group: 'canvas',
    labelKey: 'Canvas document size limit',
    bytes: true,
  },
  { key: 'canvas_max_nodes', group: 'canvas', labelKey: 'Nodes per canvas' },
  { key: 'canvas_max_edges', group: 'canvas', labelKey: 'Edges per canvas' },
  {
    key: 'canvas_node_data_max_bytes',
    group: 'canvas',
    labelKey: 'Node data size limit',
    bytes: true,
  },
  {
    key: 'canvas_user_max_bytes',
    group: 'canvas',
    labelKey: 'Canvas storage per user',
    bytes: true,
  },
  {
    key: 'task_max_concurrency',
    group: 'tasks',
    labelKey: 'Concurrent Playground tasks',
  },
  {
    key: 'task_user_result_max_bytes',
    group: 'tasks',
    labelKey: 'Task result storage per user',
    bytes: true,
  },
]

export type PlaygroundQuotaValues = Partial<
  Record<PlaygroundQuotaFieldKey, number>
>

export type PlaygroundQuotaOverride = {
  group: string
  values: PlaygroundQuotaValues
}

// readPlaygroundQuotaValues keeps only positive numbers, matching the backend
// rule that a zero or absent field inherits the value beneath it.
function readPlaygroundQuotaValues(source: unknown): PlaygroundQuotaValues {
  const record =
    source !== null && typeof source === 'object'
      ? (source as Record<string, unknown>)
      : {}
  const values: PlaygroundQuotaValues = {}
  for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      values[key] = raw
    }
  }
  return values
}

export function parsePlaygroundQuotaValues(
  json: string
): PlaygroundQuotaValues {
  return readPlaygroundQuotaValues(
    safeJsonParse<unknown>(json, { fallback: {}, silent: true })
  )
}

export function parsePlaygroundQuotaOverrides(
  json: string
): PlaygroundQuotaOverride[] {
  const parsed = safeJsonParse<unknown>(json, { fallback: {}, silent: true })
  if (parsed === null || typeof parsed !== 'object') return []
  return Object.entries(parsed as Record<string, unknown>)
    .map(([group, value]) => ({
      group,
      values: readPlaygroundQuotaValues(value),
    }))
    .sort((a, b) => a.group.localeCompare(b.group))
}
