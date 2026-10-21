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

/**
 * Split a long answer into parseable chunks without breaking its structure.
 *
 * The previous behaviour dropped markdown formatting entirely above 20k
 * characters, so a long report rendered as one flat string. Splitting on
 * blank lines that sit outside a fenced code block keeps every block intact
 * (a fence is never cut in half) while bounding the work per parse call.
 */
const DEFAULT_CHUNK_CHARS = 12_000

/**
 * Find the end index of a fenced code block that starts at `start`, or -1
 * when the fence is never closed. Indented fences and `~~~` are handled
 * because both appear in model output.
 */
function findFenceEnd(source: string, start: number): number {
  const opening = source.slice(start).match(/^(\s*)(`{3,}|~{3,})/)
  if (!opening) return -1
  const marker = opening[2]
  const fenceChar = marker[0]
  const minLength = marker.length
  let cursor = start + opening[0].length
  while (cursor < source.length) {
    const lineEnd = source.indexOf('\n', cursor)
    const line = source.slice(cursor, lineEnd === -1 ? source.length : lineEnd)
    const closing = line.match(new RegExp(`^\\s*\\${fenceChar}{${minLength},}\\s*$`))
    if (closing) {
      return lineEnd === -1 ? source.length : lineEnd + 1
    }
    if (lineEnd === -1) return -1
    cursor = lineEnd + 1
  }
  return -1
}

export function splitMarkdownChunks(
  source: string,
  maxChars = DEFAULT_CHUNK_CHARS
): string[] {
  if (source.length <= maxChars) {
    return [source]
  }

  const chunks: string[] = []
  let chunkStart = 0
  let cursor = 0

  while (cursor < source.length) {
    // A fence is copied as one unit: its interior may contain blank lines.
    const lineEnd = source.indexOf('\n', cursor)
    const line = source.slice(cursor, lineEnd === -1 ? source.length : lineEnd)
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      const fenceEnd = findFenceEnd(source, cursor)
      if (fenceEnd === -1) {
        // An unterminated fence runs to the end of the answer.
        break
      }
      cursor = fenceEnd
      continue
    }

    const isBlank = line.trim() === ''
    const reachedLimit = cursor - chunkStart >= maxChars
    if (isBlank && reachedLimit) {
      chunks.push(source.slice(chunkStart, cursor))
      // Skip the blank line itself so the next chunk starts on content.
      chunkStart = lineEnd === -1 ? source.length : lineEnd + 1
      cursor = chunkStart
      continue
    }

    if (lineEnd === -1) break
    cursor = lineEnd + 1
  }

  if (chunkStart < source.length) {
    chunks.push(source.slice(chunkStart))
  }

  return chunks.length > 0 ? chunks : [source]
}
