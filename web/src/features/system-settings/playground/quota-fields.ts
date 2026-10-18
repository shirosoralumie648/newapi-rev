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
  'trash_retention_days',
  'preset_user_max_count',
  'system_prompt_max_bytes',
  'snippet_user_max_count',
  'snippet_content_max_bytes',
  'message_max_count',
  'message_max_versions',
  'message_max_bytes',
  'parallel_compare_max_models',
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
  'canvas_snapshot_every_saves',
  'canvas_snapshot_interval_minutes',
  'canvas_snapshot_per_canvas_max_count',
  'canvas_snapshot_user_max_count',
  'canvas_snapshot_user_max_bytes',
  'object_user_max_bytes',
  'task_max_concurrency',
  'task_user_result_max_bytes',
] as const

export type PlaygroundQuotaFieldKey =
  (typeof PLAYGROUND_QUOTA_FIELD_KEYS)[number]

// The byte budgets that make up an account's storage entitlement. A
// subscription plan grants them by upgrading the buyer into a group whose
// override is larger, so the plan editor edits exactly this subset.
export const PLAYGROUND_STORAGE_QUOTA_FIELD_KEYS = [
  'attachment_user_max_bytes',
  'artifact_user_max_bytes',
  'canvas_user_max_bytes',
  'object_user_max_bytes',
  'task_user_result_max_bytes',
] as const satisfies readonly PlaygroundQuotaFieldKey[]

export const PLAYGROUND_QUOTA_GROUPS = [
  { id: 'conversations', labelKey: 'Conversations' },
  { id: 'presets', labelKey: 'Presets' },
  { id: 'snippets', labelKey: 'Prompt snippets' },
  { id: 'messages', labelKey: 'Messages' },
  { id: 'tools', labelKey: 'Tool calls' },
  { id: 'attachments', labelKey: 'Attachments' },
  { id: 'artifacts', labelKey: 'Artifacts' },
  { id: 'canvas', labelKey: 'Canvas' },
  { id: 'trash', labelKey: 'Trash' },
  { id: 'storage', labelKey: 'Storage' },
  { id: 'tasks', labelKey: 'Tasks' },
] as const

export type PlaygroundQuotaGroupId =
  (typeof PLAYGROUND_QUOTA_GROUPS)[number]['id']

export type PlaygroundQuotaField = {
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
    key: 'preset_user_max_count',
    group: 'presets',
    labelKey: 'Presets per user',
  },
  {
    key: 'system_prompt_max_bytes',
    group: 'presets',
    labelKey: 'System prompt size limit',
    bytes: true,
  },
  {
    key: 'snippet_user_max_count',
    group: 'snippets',
    labelKey: 'Prompt snippets per user',
  },
  {
    key: 'snippet_content_max_bytes',
    group: 'snippets',
    labelKey: 'Prompt snippet size limit',
    bytes: true,
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
    key: 'parallel_compare_max_models',
    group: 'messages',
    labelKey: 'Models per parallel comparison',
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
    key: 'canvas_snapshot_every_saves',
    group: 'canvas',
    labelKey: 'Canvas saves per history snapshot',
  },
  {
    key: 'canvas_snapshot_interval_minutes',
    group: 'canvas',
    labelKey: 'Canvas snapshot interval in minutes',
  },
  {
    key: 'canvas_snapshot_per_canvas_max_count',
    group: 'canvas',
    labelKey: 'History entries per canvas',
  },
  {
    key: 'canvas_snapshot_user_max_count',
    group: 'canvas',
    labelKey: 'Canvas history entries per user',
  },
  {
    key: 'canvas_snapshot_user_max_bytes',
    group: 'canvas',
    labelKey: 'Canvas history storage per user',
    bytes: true,
  },
  {
    key: 'trash_retention_days',
    group: 'trash',
    labelKey: 'Trash retention in days',
  },
  {
    key: 'object_user_max_bytes',
    group: 'storage',
    labelKey: 'Object storage per user',
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

// The quota editors work on string drafts so an empty input means "inherit"
// instead of zero. A draft carries every field; a caller renders the subset it
// owns, and serialization keeps the untouched fields intact.
export type PlaygroundQuotaDraft = Record<PlaygroundQuotaFieldKey, string>

export type PlaygroundQuotaDraftErrors = Partial<
  Record<PlaygroundQuotaFieldKey, string>
>

export type PlaygroundQuotaOverrideDraft = {
  group: string
  values: PlaygroundQuotaDraft
}

export function buildPlaygroundQuotaDraft(
  values: PlaygroundQuotaValues
): PlaygroundQuotaDraft {
  const draft = {} as PlaygroundQuotaDraft
  for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
    draft[key] = values[key] === undefined ? '' : String(values[key])
  }
  return draft
}

export function buildPlaygroundQuotaOverrideDrafts(
  overrides: PlaygroundQuotaOverride[]
): PlaygroundQuotaOverrideDraft[] {
  return overrides.map((override) => ({
    group: override.group,
    values: buildPlaygroundQuotaDraft(override.values),
  }))
}

export function isPositiveQuotaValue(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0
}

// serializePlaygroundQuotaValues writes the global default policy: every field
// is sent, and an empty input becomes 0, which the backend reads as "inherit
// the built-in limit".
export function serializePlaygroundQuotaValues(
  draft: PlaygroundQuotaDraft
): string {
  return JSON.stringify(
    Object.fromEntries(
      PLAYGROUND_QUOTA_FIELD_KEYS.map((key) => [key, Number(draft[key])])
    )
  )
}

// serializePlaygroundQuotaOverrideDrafts writes the partial override map: only
// non-empty fields are stored, and a group left with no field is dropped so it
// keeps inheriting the global default.
export function serializePlaygroundQuotaOverrideDrafts(
  overrides: PlaygroundQuotaOverrideDraft[]
): string {
  const entries = [...overrides]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((override) => {
      const values = Object.fromEntries(
        PLAYGROUND_QUOTA_FIELD_KEYS.filter(
          (key) => override.values[key] !== ''
        ).map((key) => [key, Number(override.values[key])])
      )
      return [override.group, values] as const
    })
    .filter(([, values]) => Object.keys(values).length > 0)
  return JSON.stringify(Object.fromEntries(entries))
}
