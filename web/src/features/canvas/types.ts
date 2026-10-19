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
  | 'model'
  | 'task'
  | 'task-result'
  | 'video'
  | 'audio'
  | 'group'

/**
 * Workflow steps are the nodes a run executes: a `model` chat completion and a
 * `task` generation submission. Producers (prompt/text/message/...) only feed
 * text into the chain, and `task-result` is the terminal node that receives the
 * durable task reference.
 */
export type CanvasWorkflowNodeStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type CanvasWorkflowGenerationKind = 'image' | 'video'

/**
 * What the canvas assistant offers for one reply: insert the text back onto
 * the canvas as a new node, or start an image/video generation step from it.
 */
export type CanvasAssistantMode = 'chat' | 'image' | 'video'

/**
 * Which view the canvas inspector shows. The canvas owns the whole creation
 * domain: node details and the assistant, the media generation form and task
 * list, the asset library and the artifact browser. The conversation workspace
 * no longer renders any of these panels.
 */
export type CanvasInspectorView =
  | 'details'
  | 'assistant'
  | 'generate'
  | 'library'
  | 'artifacts'

/**
 * The workflow configuration and last-run state of one step node. Only
 * configuration and ID references live here: a model id, generation parameters,
 * the resolved input text, a bounded output/error summary and the public id of
 * the durable generation task. No code and no provider URL is stored, so a
 * saved board can only describe requests through the account's own /pg routes.
 */
export type CanvasNodeWorkflowState = {
  /** Step state; absent means the step never ran. */
  status?: CanvasWorkflowNodeStatus
  /** Model id the step calls through the Playground relay. */
  model?: string
  /** Generation kind of a `task` step; defaults to image. */
  generation?: CanvasWorkflowGenerationKind
  /** Image size used by an image generation step. */
  size?: string
  /** Image quality (relay `quality`) used by an image generation step. */
  quality?: string
  /** Requested image count (relay `n`) of an image generation step. */
  imageCount?: number
  /** Video duration in seconds used by a video generation step. */
  duration?: number
  /** User group the step runs in; empty means the canvas group. */
  group?: string
  /** Input text resolved on the last attempt, reused by retry. */
  inputText?: string
  /** Reference images the last attempt read from connected nodes. */
  inputImageCount?: number
  /** Bounded text output of a model call. */
  output?: string
  /** Number of images the last image generation returned. */
  resultImageCount?: number
  /** Public id of the durable generation task the step submitted. */
  taskId?: string
  /** Canvas-local id of the step that produced a result node. */
  sourceNodeId?: string
  /** Bounded failure message of the last attempt. */
  error?: string
  /** Attempts made so far, so a retry keeps its history count. */
  attempts?: number
  /** Timestamp (ms) of the last state change. */
  updatedAt?: number
}

export type CanvasMessageSnapshot = {
  sessionId: string
  messageKey: string
  role: 'user' | 'assistant' | 'system'
  text: string
}

// References are ID claims only. The bytes of an attachment or artifact stay
// behind the owner-scoped content endpoints; a `blob:` or arbitrary URL is
// never stored as proof that a canvas owns a resource. A task result is the
// same contract: the canvas stores the public task id and the artifact key,
// and the server re-checks task ownership on every save.
export type CanvasNodeRef = {
  sessionId?: string
  messageKey?: string
  attachmentId?: string
  artifactId?: string
  taskId?: string
  taskArtifactKey?: string
}

export type CanvasNodeData = {
  kind: CanvasNodeKind
  text?: string
  snapshot?: CanvasMessageSnapshot
  ref?: CanvasNodeRef
  label?: string
  // Declared media type of an `attachment` node. Older boards were image-only
  // and carry no value, which keeps rendering as an image.
  mediaType?: string
  // Workflow configuration and last-run state of a `model`/`task` step and the
  // filled-in state of a `task-result` node.
  workflow?: CanvasNodeWorkflowState
  // Set by the read path when the node's referenced resource was deleted. The
  // node keeps its snapshot/label so the content stays visible.
  sourceDeleted?: boolean
  // Id of the `group` node that contains this node. The stored document keeps
  // the parent here and the editor derives the xyflow parent/child layout
  // (`parentId` + `extent`) from it, so a nested board round-trips.
  parentId?: string
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
  // Node ids whose referenced source no longer exists for this account.
  unavailableNodeIds?: string[]
}

/**
 * One stored history entry of a canvas document. The server keeps the document
 * bytes in the object store and answers with metadata only; `createdAt` is in
 * milliseconds like the project timestamps.
 */
export type CanvasSnapshotSummary = {
  id: string
  canvasId: string
  revision: number
  nodeCount: number
  edgeCount: number
  byteSize: number
  createdAt: number
}

/** One attachment byte snapshot stored inside an inline canvas template. */
export type CanvasTemplateAsset = {
  id: string
  /** The attachment id the template document still references. */
  sourceAttachmentId: string
  filename: string
  mediaType: string
  byteSize: number
  contentHash: string
}

export type CanvasTemplateVisibility = 'private' | 'global'

/** The list metadata of one personal, official or administrator template. */
export type CanvasTemplateSummary = {
  id: string
  name: string
  description: string
  category: string
  visibility: CanvasTemplateVisibility
  inlineAssets: boolean
  nodeCount: number
  edgeCount: number
  documentBytes: number
  assetCount: number
  assetBytes: number
  createdAt: number
  updatedAt: number
}

/** One template with its stored document and asset metadata (not the bytes). */
export type CanvasTemplateDetail = CanvasTemplateSummary & {
  document: CanvasServerDocument
  assets: CanvasTemplateAsset[]
}
