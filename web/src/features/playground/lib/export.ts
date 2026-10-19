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
  exportPlaygroundPreset,
  exportPlaygroundSession,
  exportPlaygroundSnippet,
} from '../api'
import type { PlaygroundPresetScope } from '../api'
import type { PlaygroundExportFormat } from '../types'

function downloadServerFile(download: {
  filename: string
  contentType: string
  content: string
}): void {
  const blob = new Blob([download.content], { type: download.contentType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = download.filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Downloads one conversation export. The host renders the file with attachment
 * references instead of attachment bodies, so the download stays small and the
 * browser saves it under the server-provided filename.
 */
export async function exportPlaygroundSessionFile(
  sessionId: string,
  format: PlaygroundExportFormat
): Promise<void> {
  downloadServerFile(await exportPlaygroundSession(sessionId, format))
}

/**
 * Downloads one preset as the JSON document the import endpoint accepts. The
 * server renders it, so a private and a global preset share the same format.
 */
export async function exportPlaygroundPresetFile(
  presetId: string,
  scope: PlaygroundPresetScope = 'private'
): Promise<void> {
  downloadServerFile(await exportPlaygroundPreset(presetId, scope))
}

/**
 * Downloads one prompt snippet with its full immutable version history. The
 * server renders the portable JSON document, so importing the file on another
 * account restores every revision and the production pointer.
 */
export async function exportPlaygroundSnippetFile(
  snippetId: string
): Promise<void> {
  downloadServerFile(await exportPlaygroundSnippet(snippetId))
}
