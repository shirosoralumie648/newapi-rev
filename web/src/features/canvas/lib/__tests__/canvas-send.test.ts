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
import { expect, test, vi } from 'vitest'

import { getCanvasProject, updateCanvasProject } from '../../api'
import { CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS } from '../../constants'
import type { CanvasServerDocument, CanvasServerProject } from '../../types'
import {
  buildArtifactCanvasSeeds,
  buildCanvasSendNodes,
  buildMessageCanvasSeeds,
  buildTaskResultCanvasSeeds,
  sendNodesToCanvas,
} from '../canvas-send'

vi.mock('../../api', () => ({
  createCanvasProject: vi.fn(),
  getCanvasProject: vi.fn(),
  updateCanvasProject: vi.fn(),
}))

const baseProject: CanvasServerProject = {
  id: 'c1',
  title: 'Board',
  nodeCount: 1,
  edgeCount: 0,
  documentBytes: 32,
  revision: 4,
  createdAt: 0,
  updatedAt: 0,
  document: {
    nodes: [
      {
        id: 'existing',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { kind: 'text', text: 'old' },
      },
    ],
    edges: [],
  },
}

test('a user message becomes a prompt node that keeps session and message refs', () => {
  const seeds = buildMessageCanvasSeeds({
    sessionId: 'pgs_1',
    messageKey: 'm1',
    role: 'user',
    text: 'Hello canvas',
    attachments: [{ id: 'pgf_1', filename: 'cat.png' }],
  })

  expect(seeds).toEqual([
    {
      kind: 'prompt',
      text: 'Hello canvas',
      ref: { sessionId: 'pgs_1', messageKey: 'm1' },
    },
    {
      kind: 'attachment',
      label: 'cat.png',
      ref: { sessionId: 'pgs_1', attachmentId: 'pgf_1' },
    },
  ])
})

test('an assistant message keeps a truncated snapshot and never a blob URL', () => {
  const [seed] = buildMessageCanvasSeeds({
    sessionId: 'pgs_1',
    messageKey: 'm2',
    role: 'assistant',
    text: 'a'.repeat(CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS + 50),
  })

  expect(seed.kind).toBe('message')
  expect(seed.text).toHaveLength(CANVAS_MESSAGE_SNAPSHOT_MAX_CHARS)
  expect(seed.snapshot).toEqual({
    sessionId: 'pgs_1',
    messageKey: 'm2',
    role: 'assistant',
    text: seed.text,
  })
  expect(seed.ref).toEqual({ sessionId: 'pgs_1', messageKey: 'm2' })
})

test('an artifact becomes a node that references the artifact by id', () => {
  expect(
    buildArtifactCanvasSeeds({
      sessionId: 'pgs_1',
      artifactId: 'pga_1',
      title: 'Doc',
    })
  ).toEqual([
    {
      kind: 'artifact',
      label: 'Doc',
      ref: { sessionId: 'pgs_1', artifactId: 'pga_1' },
    },
  ])
})

test('added nodes get unique ids and keep their kind and data', () => {
  const nodes = buildCanvasSendNodes(
    [
      { kind: 'text', text: 'a' },
      { kind: 'note', text: 'b' },
    ],
    3
  )

  expect(nodes).toHaveLength(2)
  expect(new Set(nodes.map((node) => node.id)).size).toBe(2)
  expect(nodes[0]).toMatchObject({
    type: 'text',
    data: { kind: 'text', text: 'a' },
  })
  expect(nodes[1]).toMatchObject({
    type: 'note',
    data: { kind: 'note', text: 'b' },
  })
})

test('appending keeps existing nodes and stores the new reference under the current revision', async () => {
  vi.mocked(getCanvasProject).mockResolvedValue(baseProject)
  vi.mocked(updateCanvasProject).mockResolvedValue(baseProject)

  await sendNodesToCanvas('c1', [
    {
      kind: 'artifact',
      label: 'Doc',
      ref: { sessionId: 'pgs_1', artifactId: 'pga_1' },
    },
  ])

  expect(getCanvasProject).toHaveBeenCalledWith('c1')
  const [id, input] = vi.mocked(updateCanvasProject).mock.calls[0]
  expect(id).toBe('c1')
  expect(input.revision).toBe(4)
  const document = input.document as CanvasServerDocument
  expect(document.nodes.map((node) => node.id)).toContain('existing')
  expect(document.nodes).toHaveLength(2)
  expect(document.nodes[1]).toMatchObject({
    type: 'artifact',
    data: {
      kind: 'artifact',
      label: 'Doc',
      ref: { sessionId: 'pgs_1', artifactId: 'pga_1' },
    },
  })
})

test('a revision conflict reloads the canvas and retries once', async () => {
  const conflict = Object.assign(new Error('conflict'), {
    response: { status: 409 },
  })
  vi.mocked(getCanvasProject)
    .mockResolvedValueOnce(baseProject)
    .mockResolvedValueOnce({ ...baseProject, revision: 5 })
  vi.mocked(updateCanvasProject)
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce({ ...baseProject, revision: 6 })

  await sendNodesToCanvas('c1', [{ kind: 'text', text: 'x' }])

  expect(getCanvasProject).toHaveBeenCalledTimes(2)
  expect(
    vi.mocked(updateCanvasProject).mock.calls.map((call) => call[1].revision)
  ).toEqual([4, 5])
})

test('a task result becomes one canvas node per artifact, referenced by task and key', () => {
  const seeds = buildTaskResultCanvasSeeds({
    taskId: 'task_1',
    label: 'kling-v1',
    artifacts: [
      { key: 'output-1', type: 'image' },
      { key: 'output-2', type: 'video' },
    ],
  })

  expect(seeds).toEqual([
    {
      kind: 'task-result',
      label: 'kling-v1 · image',
      ref: { taskId: 'task_1', taskArtifactKey: 'output-1' },
    },
    {
      kind: 'task-result',
      label: 'kling-v1 · video',
      ref: { taskId: 'task_1', taskArtifactKey: 'output-2' },
    },
  ])
})

test('a task without projected artifacts still becomes a node that references the task', () => {
  const seeds = buildTaskResultCanvasSeeds({
    taskId: 'task_1',
    label: 'kling-v1',
    artifacts: [],
  })

  expect(seeds).toEqual([
    {
      kind: 'task-result',
      label: 'kling-v1',
      ref: { taskId: 'task_1' },
    },
  ])
})
