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
import { MAX_SESSION_TAGS, MAX_SESSION_TAG_LENGTH } from '../constants'

/**
 * Normalizes a stored or server-provided tag list into the shape the UI uses.
 * Corrupt entries are dropped instead of invalidating the conversation: the
 * local storage schema treats the fields as optional, so an older snapshot or
 * a hand-edited value must still load.
 */
export function normalizeSessionTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const tags: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim()
    if (
      !tag ||
      Array.from(tag).length > MAX_SESSION_TAG_LENGTH ||
      tag.includes('\u0000') ||
      seen.has(tag)
    ) {
      continue
    }
    seen.add(tag)
    tags.push(tag)
    if (tags.length === MAX_SESSION_TAGS) break
  }
  return tags
}
