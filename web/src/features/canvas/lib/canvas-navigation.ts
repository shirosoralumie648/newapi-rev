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
import type { CanvasNodeRef } from '../types'

/** The Playground source a canvas node links back to. */
export interface CanvasSourceTarget {
  sessionId: string
  messageKey?: string
  artifactId?: string
}

/** Playground route search params for a canvas source target. */
export interface CanvasSourceSearch {
  session: string
  message?: string
  artifact?: string
}

/**
 * Resolves the navigable source of a canvas node. A session id is required;
 * message and artifact ids are carried along when the node references them.
 * Nodes that only store content (no `ref.sessionId`) stay local to the canvas.
 */
export function canvasNodeSourceTarget(
  ref?: CanvasNodeRef
): CanvasSourceTarget | null {
  if (!ref?.sessionId) return null
  const target: CanvasSourceTarget = { sessionId: ref.sessionId }
  if (ref.messageKey) target.messageKey = ref.messageKey
  if (ref.artifactId) target.artifactId = ref.artifactId
  return target
}

/** Maps a canvas source target to the Playground route search params. */
export function canvasSourceSearch(
  target: CanvasSourceTarget
): CanvasSourceSearch {
  const search: CanvasSourceSearch = { session: target.sessionId }
  if (target.messageKey) search.message = target.messageKey
  if (target.artifactId) search.artifact = target.artifactId
  return search
}
