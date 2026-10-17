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
import { z } from 'zod'

import {
  CANVAS_DOCUMENT_MAX_BYTES,
  CANVAS_MAX_EDGES,
  CANVAS_MAX_NODES,
  CANVAS_NODE_DATA_MAX_BYTES,
  CANVAS_NODE_KINDS,
} from '../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasServerDocument,
  CanvasServerProject,
  CanvasViewport,
} from '../types'

/**
 * Stable translation keys for canvas problems the UI shows directly. The
 * strings double as English source text and as i18n keys.
 */
export const CANVAS_ERRORS = {
  INVALID_FILE: 'Invalid canvas file.',
  TOO_MANY_NODES: 'Canvas supports at most 200 nodes.',
  TOO_MANY_EDGES: 'Canvas supports at most 400 edges.',
  TOO_LARGE: 'Canvas document is too large.',
  DANGLING_EDGE: 'Canvas edges must reference existing nodes.',
} as const

const canvasPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

const canvasNodeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(CANVAS_NODE_KINDS),
  position: canvasPositionSchema,
  width: z.number().finite().min(16).max(4000).optional(),
  height: z.number().finite().min(16).max(4000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

const canvasEdgeSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  source_handle: z.string().max(200).nullable().optional(),
  target_handle: z.string().max(200).nullable().optional(),
  label: z.string().max(200).optional(),
})

export const canvasDocumentSchema: z.ZodType<CanvasServerDocument> = z.object({
  viewport: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().finite().min(0.05).max(8),
    })
    .optional(),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
})

export const canvasExportSchema = z.object({
  version: z.literal(1),
  app: z.literal('new-api-canvas'),
  title: z.string().max(200).optional(),
  document: canvasDocumentSchema,
})

export function createEmptyCanvasDocument(): CanvasServerDocument {
  return { nodes: [], edges: [] }
}

/**
 * Applies the server's reference report to a loaded project. A node whose
 * referenced session/message/attachment/artifact is gone gets `sourceDeleted`
 * set, so the editor shows the deleted-source state while the stored snapshot
 * and label keep the content visible. Nodes that resolve again (or never had a
 * flag) have the marker cleared.
 */
export function applyCanvasReferenceStatus(
  project: CanvasServerProject
): CanvasServerProject {
  const unavailable = project.unavailableNodeIds ?? []
  const hasStaleFlag = project.document.nodes.some(
    (node) => node.data?.sourceDeleted === true
  )
  if (unavailable.length === 0 && !hasStaleFlag) {
    return project
  }
  const unavailableIds = new Set(unavailable)
  const nodes = project.document.nodes.map((node) => {
    const sourceDeleted = unavailableIds.has(node.id)
    if (!node.data && !sourceDeleted) {
      return node
    }
    const data = { ...node.data }
    if (sourceDeleted) {
      data.sourceDeleted = true
    } else {
      delete data.sourceDeleted
    }
    return { ...node, data }
  })
  return { ...project, document: { ...project.document, nodes } }
}

export function createCanvasNode(
  kind: CanvasNodeKind,
  position: { x: number; y: number },
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return {
    id: nanoid(),
    type: kind,
    position,
    data: { kind, ...data },
  }
}

// A grouped node stores its parent in `data.parentId`, which is the only place
// the field survives the server contract, while xyflow needs it on the node
// itself. Every mutation writes both through this helper so the persisted
// document and the live layout can never disagree.
export function canvasNodeDataWithParent(
  data: CanvasNodeData,
  parentId?: string
): CanvasNodeData {
  const next = { ...data }
  if (parentId) {
    next.parentId = parentId
  } else {
    delete next.parentId
  }
  return next
}

/**
 * xyflow renders a parent before its children, so a stored document whose
 * order changed (an import, a paste) is rewritten into parent-first order on
 * read. A child whose parent is missing or part of a cycle is emitted as a
 * top-level node instead of being dropped.
 */
export function orderCanvasNodesForFlow(
  nodes: CanvasFlowNode[]
): CanvasFlowNode[] {
  if (!nodes.some((node) => node.data.parentId)) return nodes
  const known = new Set(nodes.map((node) => node.id))
  const emitted = new Set<string>()
  const ordered: CanvasFlowNode[] = []
  let pending = nodes
  while (pending.length > 0) {
    const next: CanvasFlowNode[] = []
    let progressed = false
    for (const node of pending) {
      const parentId = node.data.parentId
      if (!parentId || !known.has(parentId) || emitted.has(parentId)) {
        ordered.push(node)
        emitted.add(node.id)
        progressed = true
      } else {
        next.push(node)
      }
    }
    if (!progressed) {
      // A cycle (an imported document) cannot be ordered; keep the rest as is.
      ordered.push(...next)
      break
    }
    pending = next
  }
  return ordered
}

export function createCanvasEdge(
  source: string,
  target: string
): CanvasFlowEdge {
  return { id: nanoid(), source, target }
}

// ReactFlow node objects carry runtime fields; the stored document keeps only
// the contract the server validates.
export function toServerDocument(
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  viewport?: CanvasViewport
): CanvasServerDocument {
  return {
    ...(viewport ? { viewport } : {}),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type as CanvasNodeKind,
      position: { x: node.position.x, y: node.position.y },
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      data: canvasNodeDataWithParent(node.data, node.parentId),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { source_handle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { target_handle: edge.targetHandle } : {}),
      ...(edge.label ? { label: String(edge.label) } : {}),
    })),
  }
}

export function fromServerDocument(document: CanvasServerDocument): {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  viewport?: CanvasViewport
} {
  // A stored document may name a parent that is gone (a hand-edited import);
  // such a node is read as a root node instead of a dangling child, and the
  // next save drops the stale parent.
  const known = new Set(document.nodes.map((node) => node.id))
  const nodes = document.nodes.map((node) => {
    const data = { kind: node.type, ...node.data } as CanvasNodeData
    const parentId =
      typeof data.parentId === 'string' && known.has(data.parentId)
        ? data.parentId
        : ''
    return {
      id: node.id,
      type: node.type,
      position: { ...node.position },
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(parentId
        ? { parentId, extent: 'parent' as const, expandParent: true }
        : {}),
      data,
    }
  })
  return {
    viewport: document.viewport,
    nodes: orderCanvasNodesForFlow(nodes),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.source_handle ? { sourceHandle: edge.source_handle } : {}),
      ...(edge.target_handle ? { targetHandle: edge.target_handle } : {}),
      ...(edge.label ? { label: edge.label } : {}),
    })),
  }
}

export function canvasDocumentByteSize(document: CanvasServerDocument): number {
  return new TextEncoder().encode(JSON.stringify(document)).length
}

export function validateCanvasDocument(
  document: CanvasServerDocument
): string | null {
  if (document.nodes.length > CANVAS_MAX_NODES) {
    return CANVAS_ERRORS.TOO_MANY_NODES
  }
  if (document.edges.length > CANVAS_MAX_EDGES) {
    return CANVAS_ERRORS.TOO_MANY_EDGES
  }
  const nodeIDs = new Set(document.nodes.map((node) => node.id))
  for (const edge of document.edges) {
    if (!nodeIDs.has(edge.source) || !nodeIDs.has(edge.target)) {
      return CANVAS_ERRORS.DANGLING_EDGE
    }
  }
  for (const node of document.nodes) {
    const dataBytes = node.data
      ? new TextEncoder().encode(JSON.stringify(node.data)).length
      : 0
    if (dataBytes > CANVAS_NODE_DATA_MAX_BYTES) {
      return CANVAS_ERRORS.TOO_LARGE
    }
  }
  if (canvasDocumentByteSize(document) > CANVAS_DOCUMENT_MAX_BYTES) {
    return CANVAS_ERRORS.TOO_LARGE
  }
  return null
}

export function parseCanvasImport(text: string): {
  title?: string
  document: CanvasServerDocument
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(CANVAS_ERRORS.INVALID_FILE)
  }
  const result = canvasExportSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(CANVAS_ERRORS.INVALID_FILE)
  }
  const limitError = validateCanvasDocument(result.data.document)
  if (limitError) {
    throw new Error(limitError)
  }
  return { title: result.data.title, document: result.data.document }
}

export function serializeCanvasExport(
  title: string,
  document: CanvasServerDocument
): string {
  return JSON.stringify(
    { version: 1, app: 'new-api-canvas', title, document },
    null,
    2
  )
}
