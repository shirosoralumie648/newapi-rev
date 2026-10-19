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

export const PLAYGROUND_MODEL_CATALOG_EMPTY_JSON = JSON.stringify(
  { groups: [], models: [] },
  null,
  2
)

/**
 * A compact starting point that names every optional field. It is content the
 * administrator edits, so its labels are examples rather than console text.
 */
export const PLAYGROUND_MODEL_CATALOG_EXAMPLE_JSON = JSON.stringify(
  {
    groups: [
      {
        id: 'recommended',
        label: 'Recommended',
        description: 'Models suitable for everyday conversations',
      },
      { id: 'fast', label: 'Fast' },
    ],
    models: [
      {
        model: 'gpt-4o',
        display_name: 'GPT-4o',
        description: 'General-purpose model with vision and tools.',
        icon: '✨',
        group: 'recommended',
        capabilities: ['vision', 'tools'],
        defaults: {
          temperature: 0.7,
          top_p: 1,
          max_tokens: 4096,
        },
        limits: {
          context_length: 128000,
          max_output_tokens: 16384,
        },
      },
    ],
    group_overrides: {
      vip: {
        groups: [{ id: 'vip-choice', label: 'VIP choice' }],
        models: [{ model: 'gpt-4o', group: 'vip-choice' }],
      },
    },
  },
  null,
  2
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pretty-prints a stored catalog for editing. An empty or malformed stored
 * value remains visible instead of being replaced, so the administrator can
 * repair it rather than silently losing the text.
 */
export function normalizePlaygroundModelCatalogJson(value: string): string {
  if (!value.trim()) return PLAYGROUND_MODEL_CATALOG_EMPTY_JSON
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return PLAYGROUND_MODEL_CATALOG_EMPTY_JSON
    return JSON.stringify(parsed, null, 2)
  } catch {
    return value
  }
}

/**
 * Catches the structural mistakes the JSON editor cannot: a non-object root,
 * a non-array group/model list, or non-object overrides. Field-level bounds and
 * references stay with the server validator, which is the single authority.
 */
export function findPlaygroundModelCatalogJsonError(
  value: string
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return 'Enter a valid JSON object for the model catalog.'
  }
  if (!isRecord(parsed)) {
    return 'Enter a valid JSON object for the model catalog.'
  }
  if (parsed.groups !== undefined && !Array.isArray(parsed.groups)) {
    return 'The model catalog groups and models must be arrays.'
  }
  if (parsed.models !== undefined && !Array.isArray(parsed.models)) {
    return 'The model catalog groups and models must be arrays.'
  }
  if (
    parsed.group_overrides !== undefined &&
    !isRecord(parsed.group_overrides)
  ) {
    return 'The model catalog group overrides must be an object.'
  }
  return null
}

/** Canonical text used to detect an unchanged draft before saving. */
export function canonicalPlaygroundModelCatalogJson(value: string): string {
  return normalizePlaygroundModelCatalogJson(value)
}
