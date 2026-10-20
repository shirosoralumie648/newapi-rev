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
import { matchesShortcutBinding } from '@/lib/shortcuts'

import {
  CANVAS_NODE_COLORS,
  CANVAS_NODE_KIND_LABELS,
  CANVAS_NODE_SEARCH_MAX_RESULTS,
  CANVAS_NODE_TAG_MAX_COUNT,
  CANVAS_NODE_TAG_MAX_LENGTH,
} from '../constants'
import type {
  CanvasFlowNode,
  CanvasNodeColor,
  CanvasNodeData,
  CanvasNodeKind,
} from '../types'
import { CANVAS_NODE_SEARCH_BINDING } from './canvas-shortcuts'

export type CanvasNodeSearchKind = CanvasNodeKind | 'all'

export interface CanvasNodeSearchOptions {
  /** Localized kind label, so a search also matches the visible node type. */
  kindLabel?: (kind: CanvasNodeKind) => string
}

/** Keeps only a palette key the current client renders. */
export function normalizeCanvasNodeColor(
  value: unknown
): CanvasNodeColor | undefined {
  if (typeof value !== 'string') return undefined
  return (CANVAS_NODE_COLORS as readonly string[]).includes(value)
    ? (value as CanvasNodeColor)
    : undefined
}

/**
 * Bounds an imported or edited tag list: trims, drops empty/NUL/overlong
 * entries, deduplicates exactly and stops at the count limit. Invalid entries
 * are dropped instead of failing the board, so a hand-edited export still
 * opens with every other field intact.
 */
export function normalizeCanvasNodeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (!tag || tag.includes('\0')) continue
    if (Array.from(tag).length > CANVAS_NODE_TAG_MAX_LENGTH) continue
    if (tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= CANVAS_NODE_TAG_MAX_COUNT) break
  }
  return tags
}

/** A one-line content excerpt shown under a search result. */
export function canvasNodeSearchPreview(data: CanvasNodeData): string {
  const text =
    data.text?.trim() ||
    data.snapshot?.text?.trim() ||
    data.workflow?.output?.trim() ||
    data.workflow?.error?.trim() ||
    ''
  return text.replace(/\s+/g, ' ').slice(0, 160)
}

function canvasNodeSearchText(
  node: CanvasFlowNode,
  options: CanvasNodeSearchOptions
): string {
  const data = node.data
  const kindLabel =
    options.kindLabel?.(data.kind) ?? CANVAS_NODE_KIND_LABELS[data.kind]
  return [
    data.label ?? '',
    kindLabel,
    (data.tags ?? []).join(' '),
    data.text ?? '',
    data.snapshot?.text ?? '',
    data.workflow?.output ?? '',
    data.workflow?.error ?? '',
  ]
    .join('\n')
    .toLowerCase()
}

/**
 * Filters the current board's nodes by kind and a case-insensitive match on
 * name, tag, kind label or content. Selection and run state are intentionally
 * ignored: search is a navigation aid over every node on the board.
 */
export function canvasSearchNodes(
  nodes: CanvasFlowNode[],
  query: string,
  kind: CanvasNodeSearchKind,
  options: CanvasNodeSearchOptions = {}
): CanvasFlowNode[] {
  const needle = query.trim().toLowerCase()
  const matches: CanvasFlowNode[] = []
  for (const node of nodes) {
    if (kind !== 'all' && node.data.kind !== kind) continue
    if (needle && !canvasNodeSearchText(node, options).includes(needle)) {
      continue
    }
    matches.push(node)
    if (matches.length >= CANVAS_NODE_SEARCH_MAX_RESULTS) break
  }
  return matches
}

/** Cmd+P on macOS and Ctrl+P elsewhere; modified chords stay untouched. */
export function isCanvasNodeSearchShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): boolean {
  return matchesShortcutBinding(event, CANVAS_NODE_SEARCH_BINDING)
}
