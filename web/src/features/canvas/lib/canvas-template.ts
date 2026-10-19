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
import { nanoid } from 'nanoid'

import { CANVAS_NODE_ESTIMATED_WIDTH } from '../constants'
import type {
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasNodeRef,
  CanvasServerDocument,
  CanvasServerNode,
  CanvasTemplateAsset,
} from '../types'

export const CANVAS_TEMPLATE_ERRORS = {
  EMPTY: 'This template has no nodes.',
  FULL: 'The canvas cannot fit this template.',
} as const

/** The key a template asset uses to resolve a document ref on apply. */
export function canvasTemplateAssetSource(asset: CanvasTemplateAsset): string {
  return asset.sourceAttachmentId || asset.id
}

/**
 * The attachment ids the template document references. Only these assets need
 * to be re-uploaded when the template is applied.
 */
export function canvasTemplateReferencedAttachments(
  document: CanvasServerDocument
): Set<string> {
  const ids = new Set<string>()
  for (const node of document.nodes) {
    const ref = node.data?.ref as CanvasNodeRef | undefined
    if (typeof ref?.attachmentId === 'string' && ref.attachmentId) {
      ids.add(ref.attachmentId)
    }
  }
  return ids
}

export type CanvasTemplateGraphEntry = {
  id: string
  kind: CanvasNodeKind
  position: { x: number; y: number }
  data: Partial<CanvasNodeData>
}

export type CanvasTemplateGraphLink = {
  source: number
  target: number
}

export type CanvasTemplateMaterialization = {
  document: CanvasServerDocument
  entries: CanvasTemplateGraphEntry[]
  links: CanvasTemplateGraphLink[]
  droppedRefs: number
}

export type CanvasTemplatePosition = { x: number; y: number }

/**
 * Materializes a stored template document for one target canvas. Every node and
 * edge gets a fresh id, the group links are remapped to the new ids, and an
 * attachment ref is kept only when the apply path uploaded its bytes into the
 * target canvas. The same result feeds both the create-new-canvas document and
 * the one-step graph insertion into the current canvas.
 */
export function canvasTemplateMaterialization(
  document: CanvasServerDocument,
  attachments: Record<string, string>,
  canvasId: string,
  offset: CanvasTemplatePosition = { x: 0, y: 0 },
  includeViewport = true
): CanvasTemplateMaterialization {
  const newIDs = new Map<string, string>()
  for (const node of document.nodes) {
    newIDs.set(node.id, nanoid())
  }

  const nodes: CanvasServerDocument['nodes'] = []
  const entries: CanvasTemplateGraphEntry[] = []
  const indexByID = new Map<string, number>()
  let droppedRefs = 0
  for (const node of document.nodes) {
    const nodeID = newIDs.get(node.id)
    if (!nodeID) continue
    const data: Partial<CanvasNodeData> = {
      ...(node.data ?? {}),
    } as Partial<CanvasNodeData>
    data.kind = node.type
    delete data.sourceDeleted
    const ref = data.ref as CanvasNodeRef | undefined
    if (ref) {
      const source =
        typeof ref.attachmentId === 'string' ? ref.attachmentId : ''
      const uploaded = source ? attachments[source] : undefined
      if (uploaded) {
        data.ref = { sessionId: canvasId, attachmentId: uploaded }
      } else {
        delete data.ref
        droppedRefs += 1
      }
    }
    if (data.parentId) {
      const parent = newIDs.get(data.parentId)
      if (parent) {
        data.parentId = parent
      } else {
        delete data.parentId
      }
    }
    const position = {
      x: node.position.x + offset.x,
      y: node.position.y + offset.y,
    }
    const serverNode: CanvasServerNode = {
      id: nodeID,
      type: node.type,
      position,
      data: data as Record<string, unknown>,
    }
    if (node.width !== undefined) serverNode.width = node.width
    if (node.height !== undefined) serverNode.height = node.height
    nodes.push(serverNode)
    indexByID.set(node.id, entries.length)
    entries.push({
      id: nodeID,
      kind: node.type,
      position: { ...position },
      data,
    })
  }

  const edges: CanvasServerDocument['edges'] = []
  const links: CanvasTemplateGraphLink[] = []
  for (const edge of document.edges) {
    const source = newIDs.get(edge.source)
    const target = newIDs.get(edge.target)
    const sourceIndex = indexByID.get(edge.source)
    const targetIndex = indexByID.get(edge.target)
    if (
      !source ||
      !target ||
      sourceIndex === undefined ||
      targetIndex === undefined
    ) {
      continue
    }
    const next = {
      id: nanoid(),
      source,
      target,
      ...(edge.source_handle !== undefined
        ? { source_handle: edge.source_handle }
        : {}),
      ...(edge.target_handle !== undefined
        ? { target_handle: edge.target_handle }
        : {}),
      ...(edge.label !== undefined ? { label: edge.label } : {}),
    }
    edges.push(next)
    links.push({ source: sourceIndex, target: targetIndex })
  }

  const result: CanvasServerDocument = { nodes, edges }
  if (includeViewport && document.viewport) {
    result.viewport = { ...document.viewport }
  }
  return { document: result, entries, links, droppedRefs }
}

/**
 * Places a template beside the current board instead of on top of it. The
 * returned offset aligns the template's left edge to the right of the rightmost
 * existing node with one gap.
 */
export function canvasTemplateOffset(
  nodes: CanvasFlowNode[],
  document: CanvasServerDocument,
  gap = 80
): CanvasTemplatePosition {
  if (nodes.length === 0 || document.nodes.length === 0) {
    return { x: 0, y: 0 }
  }
  let right = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    const width =
      node.measured?.width ?? node.width ?? CANVAS_NODE_ESTIMATED_WIDTH
    right = Math.max(right, node.position.x + width)
  }
  let left = Number.POSITIVE_INFINITY
  for (const node of document.nodes) {
    left = Math.min(left, node.position.x)
  }
  if (!Number.isFinite(right) || !Number.isFinite(left)) {
    return { x: 0, y: 0 }
  }
  return { x: right + gap - left, y: 0 }
}
