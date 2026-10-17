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
      ...(node.data ? { data: { ...node.data } } : {}),
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
  return {
    viewport: document.viewport,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { ...node.position },
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      data: { kind: node.type, ...node.data } as CanvasNodeData,
    })),
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

export function validateCanvasDocument(document: CanvasServerDocument): string | null {
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
