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
  CanvasInspectorView,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasNodeRef,
  CanvasWorkflowGenerationKind,
} from '../types'

/** Every search param the canvas route accepts. */
export interface CanvasRouteSearch {
  project?: string
  prompt?: string
  generate?: CanvasWorkflowGenerationKind
  session?: string
  message?: string
  artifact?: string
  /** Comma-separated attachment ids of the source message version. */
  attachment?: string
  /** Inspector view a palette command asked the canvas to open. */
  view?: CanvasInspectorView
}

/** The Playground source a canvas node links back to. */
export interface CanvasSourceTarget {
  sessionId: string
  messageKey?: string
  artifactId?: string
}

/** One saved artifact a canvas deep link opens in the artifact browser. */
export interface CanvasArtifactTarget {
  sessionId: string
  artifactId: string
}

/** Playground route search params for a canvas source target. */
export interface CanvasSourceSearch {
  session: string
  message?: string
  artifact?: string
}

/**
 * The canvas route search params a conversation message action produces when
 * the user asks to generate media from a reply. The prompt and reference image
 * ids travel in the URL, so the canvas editor can prefill a task node without
 * the chat workspace rendering any generation UI.
 */
export interface CanvasGenerationSearch {
  prompt?: string
  generate?: string
  session?: string
  message?: string
  /** Comma-separated attachment ids of the message version. */
  attachment?: string
}

/** A validated generation prefill the canvas editor turns into a task node. */
export interface CanvasGenerationPrefill {
  prompt: string
  kind: CanvasWorkflowGenerationKind
  sessionId?: string
  messageKey?: string
  attachmentIds: string[]
}

/** The bounded prompt a generation prefill carries. */
export const CANVAS_GENERATION_PREFILL_MAX_CHARS = 4000

/**
 * Resolves the generation search params into a prefill. An unknown generation
 * kind or an empty prompt means the route was not a generation link and the
 * editor behaves normally.
 */
export function canvasGenerationPrefill(
  search: CanvasGenerationSearch
): CanvasGenerationPrefill | null {
  const prompt = search.prompt
    ?.trim()
    .slice(0, CANVAS_GENERATION_PREFILL_MAX_CHARS)
  if (!prompt) return null
  let kind: CanvasWorkflowGenerationKind = 'image'
  if (search.generate === 'video') kind = 'video'
  else if (search.generate !== undefined && search.generate !== 'image') {
    return null
  }
  const attachmentIds = (search.attachment ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return {
    prompt,
    kind,
    ...(search.session ? { sessionId: search.session } : {}),
    ...(search.message ? { messageKey: search.message } : {}),
    attachmentIds,
  }
}

/** Maps a generation prefill to the canvas route search params. */
export function canvasGenerationSearch(
  prefill: CanvasGenerationPrefill
): CanvasGenerationSearch {
  return {
    prompt: prefill.prompt,
    generate: prefill.kind,
    ...(prefill.sessionId ? { session: prefill.sessionId } : {}),
    ...(prefill.messageKey ? { message: prefill.messageKey } : {}),
    ...(prefill.attachmentIds.length > 0
      ? { attachment: prefill.attachmentIds.join(',') }
      : {}),
  }
}

/** One node and its data a prefill adds to the canvas in a single step. */
export interface CanvasPrefillEntry {
  kind: CanvasNodeKind
  position: { x: number; y: number }
  data: Partial<CanvasNodeData>
}

export interface CanvasPrefillGraph {
  entries: CanvasPrefillEntry[]
  /** Edges between entries, by entry index. */
  links: { source: number; target: number }[]
}

/**
 * Builds the task node and its reference attachment nodes for a generation
 * prefill. The attachment nodes are wired into the task step, so the workflow
 * runner reads them through the owner-scoped content endpoint exactly like a
 * reference image the user connected by hand.
 */
export function canvasGenerationPrefillGraph(
  prefill: CanvasGenerationPrefill,
  existingCount: number
): CanvasPrefillGraph {
  const cascade = (existingCount % 8) * 32
  const taskX = 96 + cascade
  const taskY = 96 + cascade
  const entries: CanvasPrefillEntry[] = [
    {
      kind: 'task',
      position: { x: taskX, y: taskY },
      data: {
        kind: 'task',
        text: prefill.prompt,
        workflow: { generation: prefill.kind },
      },
    },
  ]
  const links: { source: number; target: number }[] = []
  if (!prefill.sessionId) return { entries, links }
  prefill.attachmentIds.forEach((attachmentId, index) => {
    entries.push({
      kind: 'attachment',
      position: { x: taskX - 300, y: taskY + index * 180 },
      data: {
        kind: 'attachment',
        ref: { sessionId: prefill.sessionId, attachmentId },
      },
    })
    links.push({ source: index + 1, target: 0 })
  })
  return { entries, links }
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
