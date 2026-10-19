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
import {
  PLAYGROUND_SNIPPET_FILE_FORMAT,
  PLAYGROUND_SNIPPET_FILE_VERSION,
} from '../../constants'

export interface PromptSnippetFileVersion {
  version: number
  content: string
  createdAt?: number
}

/** The portable prompt template document produced by the export endpoint. */
export interface PromptSnippetFileDocument {
  format: typeof PLAYGROUND_SNIPPET_FILE_FORMAT
  schemaVersion: number
  exportedAt?: number
  template: {
    name: string
    productionVersion: number
    versions: PromptSnippetFileVersion[]
  }
}

export const PROMPT_SNIPPET_FILE_ERROR = 'Invalid prompt snippet file.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readVersion(
  value: unknown,
  expected: number
): PromptSnippetFileVersion {
  if (!isRecord(value)) throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  if (value.version !== expected || typeof value.content !== 'string') {
    throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  }
  const version: PromptSnippetFileVersion = {
    version: expected,
    content: value.content,
  }
  if (typeof value.created_at === 'number' && value.created_at >= 0) {
    version.createdAt = value.created_at
  }
  return version
}

/**
 * Validate a download before it is uploaded again. The server repeats every
 * check; rejecting here only keeps an unrelated JSON file from becoming a
 * failed request and gives the owner an immediate message.
 */
export function parsePromptSnippetFile(
  text: string
): PromptSnippetFileDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  }
  if (!isRecord(parsed) || !isRecord(parsed.template)) {
    throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  }
  if (
    parsed.format !== PLAYGROUND_SNIPPET_FILE_FORMAT ||
    parsed.schema_version !== PLAYGROUND_SNIPPET_FILE_VERSION
  ) {
    throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  }
  const rawTemplate = parsed.template
  if (
    typeof rawTemplate.name !== 'string' ||
    !rawTemplate.name.trim() ||
    !Array.isArray(rawTemplate.versions) ||
    rawTemplate.versions.length === 0
  ) {
    throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  }
  const versions = rawTemplate.versions.map((value, index) =>
    readVersion(value, index + 1)
  )
  const production = rawTemplate.production_version
  if (
    typeof production !== 'number' ||
    !Number.isInteger(production) ||
    production < 1 ||
    production > versions.length
  ) {
    throw new Error(PROMPT_SNIPPET_FILE_ERROR)
  }
  const document: PromptSnippetFileDocument = {
    format: PLAYGROUND_SNIPPET_FILE_FORMAT,
    schemaVersion: PLAYGROUND_SNIPPET_FILE_VERSION,
    template: {
      name: rawTemplate.name.trim(),
      productionVersion: production,
      versions,
    },
  }
  if (typeof parsed.exported_at === 'number' && parsed.exported_at >= 0) {
    document.exportedAt = parsed.exported_at
  }
  return document
}
