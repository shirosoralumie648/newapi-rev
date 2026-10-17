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

import { getServerErrorStatus } from '@/lib/server-error-message'

import {
  createCanvasProject,
  getCanvasProject,
  updateCanvasProject,
} from '../api'
import {
  CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS,
  CANVAS_NODE_ADD_OFFSET,
} from '../constants'
import type {
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasServerProject,
} from '../types'
import {
  createCanvasNode,
  fromServerDocument,
  toServerDocument,
  validateCanvasDocument,
} from './canvas-document'

/**
 * One node to add to a canvas. The caller describes the kind and the reference
 * IDs; this module places the node and persists it. References are stored as
 * IDs only, so the server can re-check ownership on every save.
 */
export type CanvasSendSeed = CanvasNodeData

export const CANVAS_SEND_ERRORS = {
  FAILED: 'Unable to add nodes to the canvas.',
} as const

export interface MessageCanvasSeedInput {
  sessionId: string
  messageKey: string
  role: 'user' | 'assistant' | 'system'
  text: string
  attachments?: { id: string; filename?: string }[]
}

export interface ArtifactCanvasSeedInput {
  sessionId: string
  artifactId: string
  title: string
}

/**
 * Maps one chat message to canvas nodes: the message itself becomes a prompt
 * (user) or message (assistant) node, and each attachment becomes an
 * attachment node. Only IDs are stored, never a blob URL, so the server can
 * re-verify ownership and the bytes stay behind the content endpoint.
 */
export function buildMessageCanvasSeeds(
  input: MessageCanvasSeedInput
): CanvasSendSeed[] {
  const text = input.text.trim().slice(0, CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS)
  const kind: CanvasNodeKind = input.role === 'user' ? 'prompt' : 'message'
  const seeds: CanvasSendSeed[] = [
    kind === 'message'
      ? {
          kind,
          text,
          snapshot: {
            sessionId: input.sessionId,
            messageKey: input.messageKey,
            role: input.role,
            text,
          },
          ref: { sessionId: input.sessionId, messageKey: input.messageKey },
        }
      : {
          kind,
          text,
          ref: { sessionId: input.sessionId, messageKey: input.messageKey },
        },
  ]
  for (const attachment of input.attachments ?? []) {
    seeds.push({
      kind: 'attachment',
      ...(attachment.filename ? { label: attachment.filename } : {}),
      ref: { sessionId: input.sessionId, attachmentId: attachment.id },
    })
  }
  return seeds
}

/** Maps one saved artifact to a canvas node that references it by ID. */
export function buildArtifactCanvasSeeds(
  input: ArtifactCanvasSeedInput
): CanvasSendSeed[] {
  return [
    {
      kind: 'artifact',
      label: input.title,
      ref: { sessionId: input.sessionId, artifactId: input.artifactId },
    },
  ]
}

export interface TaskResultCanvasSeedInput {
  taskId: string
  label: string
  artifacts: { key: string; type: string }[]
}

/**
 * Maps one async generation task to canvas nodes. Each artifact the task
 * exposes becomes a `task-result` node that references the task by its public
 * id plus the artifact key; the bytes stay behind the owner-scoped task
 * artifact endpoints, so the canvas never stores a provider URL. A task
 * without artifacts still yields one node that references the task itself.
 */
export function buildTaskResultCanvasSeeds(
  input: TaskResultCanvasSeedInput
): CanvasSendSeed[] {
  if (input.artifacts.length === 0) {
    return [
      {
        kind: 'task-result',
        label: input.label,
        ref: { taskId: input.taskId },
      },
    ]
  }
  return input.artifacts.map((artifact) => ({
    kind: 'task-result' as const,
    label: `${input.label} · ${artifact.type}`,
    ref: {
      taskId: input.taskId,
      ...(artifact.key ? { taskArtifactKey: artifact.key } : {}),
    },
  }))
}

/** Places the given nodes in a small cascade below the existing content. */
export function buildCanvasSendNodes(
  seeds: CanvasSendSeed[],
  existingCount: number
): CanvasFlowNode[] {
  return seeds.map((seed, index) => {
    const cascade = CANVAS_NODE_ADD_OFFSET * ((existingCount + index) % 8)
    const { kind, ...data } = seed
    return createCanvasNode(kind, { x: 96 + cascade, y: 96 + cascade }, data)
  })
}

function appendNodes(
  project: CanvasServerProject,
  seeds: CanvasSendSeed[]
): Promise<CanvasServerProject> {
  const restored = fromServerDocument(project.document)
  const document = toServerDocument(
    [...restored.nodes, ...buildCanvasSendNodes(seeds, restored.nodes.length)],
    restored.edges,
    project.document.viewport
  )
  const limitError = validateCanvasDocument(document)
  if (limitError) {
    return Promise.reject(new Error(limitError))
  }
  return updateCanvasProject(project.id, {
    revision: project.revision,
    document,
  })
}

/**
 * Adds nodes to an existing canvas. A single concurrent revision conflict is
 * retried against the freshly loaded document; the canvas is otherwise left
 * untouched so the user can retry without losing the source resource.
 */
export async function sendNodesToCanvas(
  projectId: string,
  seeds: CanvasSendSeed[]
): Promise<CanvasServerProject> {
  const project = await getCanvasProject(projectId)
  try {
    return await appendNodes(project, seeds)
  } catch (error) {
    if (getServerErrorStatus(error) !== 409) throw error
    const latest = await getCanvasProject(projectId)
    return appendNodes(latest, seeds)
  }
}

/** Creates a canvas that already contains the given nodes. */
export function createCanvasWithNodes(
  title: string,
  seeds: CanvasSendSeed[]
): Promise<CanvasServerProject> {
  const document = toServerDocument(buildCanvasSendNodes(seeds, 0), [])
  const limitError = validateCanvasDocument(document)
  if (limitError) {
    return Promise.reject(new Error(limitError))
  }
  return createCanvasProject({ clientId: nanoid(), title, document })
}
