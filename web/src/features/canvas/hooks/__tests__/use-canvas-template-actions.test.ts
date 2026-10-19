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
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { PlaygroundServerAttachment } from '@/features/playground/api'
import { uploadPlaygroundAttachmentDirect } from '@/features/playground/lib/attachment-upload'

import {
  createCanvasProject,
  deleteCanvasProject,
  getCanvasTemplateAssetBlob,
  updateCanvasProject,
} from '../../api'
import { CANVAS_TEMPLATE_ERRORS } from '../../lib/canvas-template'
import type { CanvasServerProject, CanvasTemplateDetail } from '../../types'
import { useCanvasTemplateActions } from '../use-canvas-template-actions'

vi.mock('../../api', () => ({
  createCanvasProject: vi.fn(),
  deleteCanvasProject: vi.fn(),
  getCanvasTemplateAssetBlob: vi.fn(),
  updateCanvasProject: vi.fn(),
}))

vi.mock('@/features/playground/lib/attachment-upload', () => ({
  uploadPlaygroundAttachmentDirect: vi.fn(),
}))

function attachment(id: string): PlaygroundServerAttachment {
  return {
    id,
    sessionId: '',
    mediaType: 'image/png',
    filename: `${id}.png`,
    byteSize: 4,
    createdAt: 0,
    updatedAt: 0,
  }
}

const template: CanvasTemplateDetail = {
  id: 'pgct_1',
  name: 'Chain',
  description: '',
  category: 'translation',
  visibility: 'private',
  inlineAssets: true,
  nodeCount: 2,
  edgeCount: 1,
  documentBytes: 128,
  assetCount: 2,
  assetBytes: 8,
  createdAt: 0,
  updatedAt: 0,
  document: {
    nodes: [
      {
        id: 'prompt',
        type: 'prompt',
        position: { x: 0, y: 0 },
        data: { kind: 'prompt', text: 'Translate.' },
      },
      {
        id: 'image',
        type: 'attachment',
        position: { x: 200, y: 0 },
        data: {
          kind: 'attachment',
          ref: { sessionId: 'source', attachmentId: 'att-1' },
        },
      },
    ],
    edges: [{ id: 'edge', source: 'prompt', target: 'image' }],
  },
  assets: [
    {
      id: 'asset-1',
      sourceAttachmentId: 'att-1',
      filename: 'reference.png',
      mediaType: 'image/png',
      byteSize: 4,
      contentHash: 'hash-1',
    },
    {
      id: 'asset-2',
      sourceAttachmentId: 'att-unused',
      filename: 'unused.png',
      mediaType: 'image/png',
      byteSize: 4,
      contentHash: 'hash-2',
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCanvasTemplateAssetBlob).mockResolvedValue(
    new Blob(['png'], { type: 'image/png' })
  )
  vi.mocked(uploadPlaygroundAttachmentDirect).mockResolvedValue(
    attachment('att-new')
  )
})

test('apply uploads only referenced assets and inserts the remapped graph', async () => {
  const addGraph = vi.fn().mockReturnValue(['node-new'])
  const selectNode = vi.fn()
  const { result } = renderHook(() =>
    useCanvasTemplateActions({
      projectId: 'canvas-1',
      nodes: [],
      addGraph,
      selectNode,
      onOpenProject: vi.fn(),
    })
  )

  let applied: { droppedRefs: number } | undefined
  await act(async () => {
    applied = await result.current.applyToCurrent(template)
  })

  expect(getCanvasTemplateAssetBlob).toHaveBeenCalledTimes(1)
  expect(getCanvasTemplateAssetBlob).toHaveBeenCalledWith('pgct_1', 'asset-1')
  expect(uploadPlaygroundAttachmentDirect).toHaveBeenCalledWith(
    { canvasId: 'canvas-1' },
    expect.objectContaining({
      name: 'reference.png',
      type: 'image/png',
    })
  )
  expect(applied).toEqual({ droppedRefs: 0 })
  expect(addGraph).toHaveBeenCalledTimes(1)
  const [entries, links] = addGraph.mock.calls[0] as [
    Array<{ id: string; data: { ref?: unknown } }>,
    Array<{ source: number; target: number }>,
  ]
  expect(entries).toHaveLength(2)
  expect(entries[1].data.ref).toEqual({
    sessionId: 'canvas-1',
    attachmentId: 'att-new',
  })
  expect(links).toEqual([{ source: 0, target: 1 }])
  expect(selectNode).toHaveBeenCalledWith('node-new')
})

test('apply rejects an empty template without touching the graph', async () => {
  const addGraph = vi.fn()
  const { result } = renderHook(() =>
    useCanvasTemplateActions({
      projectId: 'canvas-1',
      nodes: [],
      addGraph,
      selectNode: vi.fn(),
      onOpenProject: vi.fn(),
    })
  )

  await expect(
    act(async () => {
      await result.current.applyToCurrent({
        ...template,
        document: { nodes: [], edges: [] },
        assets: [],
      })
    })
  ).rejects.toThrow(CANVAS_TEMPLATE_ERRORS.EMPTY)
  expect(addGraph).not.toHaveBeenCalled()
})

test('apply reports a full canvas when the graph cannot accept the nodes', async () => {
  const { result } = renderHook(() =>
    useCanvasTemplateActions({
      projectId: 'canvas-1',
      nodes: [],
      addGraph: vi.fn().mockReturnValue(null),
      selectNode: vi.fn(),
      onOpenProject: vi.fn(),
    })
  )

  await expect(
    act(async () => {
      await result.current.applyToCurrent(template)
    })
  ).rejects.toThrow(CANVAS_TEMPLATE_ERRORS.FULL)
})

test('creates a new canvas, saves the remapped document and opens it', async () => {
  const project = {
    id: 'canvas-new',
    title: 'Chain',
    nodeCount: 0,
    edgeCount: 0,
    documentBytes: 2,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    document: { nodes: [], edges: [] },
  } as CanvasServerProject
  vi.mocked(createCanvasProject).mockResolvedValue(project)
  vi.mocked(updateCanvasProject).mockResolvedValue(project)
  const onOpenProject = vi.fn()
  const { result } = renderHook(() =>
    useCanvasTemplateActions({
      projectId: 'canvas-1',
      nodes: [],
      addGraph: vi.fn(),
      selectNode: vi.fn(),
      onOpenProject,
    })
  )

  let created: { droppedRefs: number } | undefined
  await act(async () => {
    created = await result.current.createFromTemplate(template)
  })

  expect(createCanvasProject).toHaveBeenCalledWith({
    title: 'Chain',
    document: { nodes: [], edges: [] },
  })
  expect(uploadPlaygroundAttachmentDirect).toHaveBeenCalledWith(
    { canvasId: 'canvas-new' },
    expect.any(File)
  )
  expect(updateCanvasProject).toHaveBeenCalledWith('canvas-new', {
    revision: 0,
    document: expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            ref: { sessionId: 'canvas-new', attachmentId: 'att-new' },
          }),
        }),
      ]),
    }),
  })
  expect(created).toEqual({ droppedRefs: 0 })
  expect(onOpenProject).toHaveBeenCalledWith('canvas-new')
})

test('deletes the half-created canvas when the document save fails', async () => {
  const project = {
    id: 'canvas-new',
    revision: 0,
  } as CanvasServerProject
  vi.mocked(createCanvasProject).mockResolvedValue(project)
  const failure = new Error('save failed')
  vi.mocked(updateCanvasProject).mockRejectedValue(failure)
  vi.mocked(deleteCanvasProject).mockResolvedValue(undefined)
  const onOpenProject = vi.fn()
  const { result } = renderHook(() =>
    useCanvasTemplateActions({
      projectId: 'canvas-1',
      nodes: [],
      addGraph: vi.fn(),
      selectNode: vi.fn(),
      onOpenProject,
    })
  )

  await expect(
    act(async () => {
      await result.current.createFromTemplate(template)
    })
  ).rejects.toBe(failure)
  expect(deleteCanvasProject).toHaveBeenCalledWith('canvas-new')
  expect(onOpenProject).not.toHaveBeenCalled()
})
