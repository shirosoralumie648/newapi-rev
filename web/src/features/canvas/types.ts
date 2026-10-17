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
import type { Edge, Node } from '@xyflow/react'

export type CanvasNodeKind =
  | 'text'
  | 'note'
  | 'prompt'
  | 'message'
  | 'attachment'
  | 'image'
  | 'artifact'
  | 'task'
  | 'task-result'

export type CanvasMessageSnapshot = {
  sessionId: string
  messageKey: string
  role: 'user' | 'assistant' | 'system'
  text: string
}

// References are ID claims only. The bytes of an attachment or artifact stay
// behind the owner-scoped content endpoints; a `blob:` or arbitrary URL is
// never stored as proof that a canvas owns a resource.
export type CanvasNodeRef = {
  sessionId?: string
  messageKey?: string
  attachmentId?: string
  artifactId?: string
}

export type CanvasNodeData = {
  kind: CanvasNodeKind
  text?: string
  snapshot?: CanvasMessageSnapshot
  ref?: CanvasNodeRef
  label?: string
}

export type CanvasFlowNode = Node<CanvasNodeData>
export type CanvasFlowEdge = Edge

export type CanvasViewport = {
  x: number
  y: number
  zoom: number
}

// The stored document contract the server validates; `canvasDocumentSchema`
// in `lib/canvas-document.ts` parses the same shape.
export type CanvasServerNode = {
  id: string
  type: CanvasNodeKind
  position: { x: number; y: number }
  width?: number
  height?: number
  data?: Record<string, unknown>
}

export type CanvasServerEdge = {
  id: string
  source: string
  target: string
  source_handle?: string | null
  target_handle?: string | null
  label?: string
}

export type CanvasServerDocument = {
  viewport?: CanvasViewport
  nodes: CanvasServerNode[]
  edges: CanvasServerEdge[]
}

export type CanvasProjectSummary = {
  id: string
  clientId?: string
  title: string
  nodeCount: number
  edgeCount: number
  documentBytes: number
  revision: number
  createdAt: number
  updatedAt: number
}

export type CanvasServerProject = CanvasProjectSummary & {
  document: CanvasServerDocument
}
