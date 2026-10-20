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
  updateCanvasProject,
} from '../../api'
import {
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
} from '../../constants'
import type { CanvasServerDocument, CanvasServerProject } from '../../types'
import { useCanvasVideoFrameActions } from '../use-canvas-video-frame-actions'

vi.mock('../../api', () => ({
  createCanvasProject: vi.fn(),
  deleteCanvasProject: vi.fn(),
  updateCanvasProject: vi.fn(),
}))

vi.mock('@/features/playground/lib/attachment-upload', () => ({
  uploadPlaygroundAttachmentDirect: vi.fn(),
}))

function canvasProject(): CanvasServerProject {
  return {
    id: 'pc1',
    title: 'Ocean · Frame',
    mode: 'image',
    nodeCount: 0,
    edgeCount: 0,
    documentBytes: 0,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    document: { nodes: [], edges: [] },
  }
}

function frameAttachment(): PlaygroundServerAttachment {
  return {
    id: 'a1',
    sessionId: 'pc1',
    mediaType: 'image/jpeg',
    filename: 'video-frame-12.3s.jpg',
    byteSize: 5,
    createdAt: 0,
    updatedAt: 0,
  }
}

const frame = new File(['frame'], 'video-frame-12.3s.jpg', {
  type: 'image/jpeg',
})

beforeEach(() => {
  vi.mocked(createCanvasProject).mockResolvedValue(canvasProject())
  vi.mocked(updateCanvasProject).mockResolvedValue(canvasProject())
  vi.mocked(uploadPlaygroundAttachmentDirect).mockResolvedValue(
    frameAttachment()
  )
  vi.mocked(deleteCanvasProject).mockResolvedValue(undefined)
})

test('creates an image workbench whose step consumes the frame as a reference', async () => {
  const onOpenProject = vi.fn(async () => undefined)
  const { result } = renderHook(() =>
    useCanvasVideoFrameActions({ sourceTitle: 'Ocean', onOpenProject })
  )

  await act(async () => {
    await result.current.createImageWorkbenchFromFrame(frame)
  })

  expect(createCanvasProject).toHaveBeenCalledWith({
    clientId: expect.any(String),
    title: 'Ocean · Frame',
    mode: 'image',
    document: { nodes: [], edges: [] },
  })
  expect(uploadPlaygroundAttachmentDirect).toHaveBeenCalledWith(
    { canvasId: 'pc1' },
    frame
  )
  const update = vi.mocked(updateCanvasProject).mock.calls[0]
  expect(update?.[0]).toBe('pc1')
  expect(update?.[1].revision).toBe(1)
  const document = update?.[1].document as CanvasServerDocument | undefined
  const frameNode = document?.nodes.find((node) => node.type === 'image')
  const stepNode = document?.nodes.find((node) => node.type === 'task')
  expect(frameNode).toMatchObject({
    id: expect.any(String),
    type: 'image',
    position: { x: CANVAS_NODE_ADD_BASE, y: CANVAS_NODE_ADD_BASE },
    data: {
      kind: 'image',
      label: 'video-frame-12.3s.jpg',
      mediaType: 'image/jpeg',
      ref: { sessionId: 'pc1', attachmentId: 'a1' },
    },
  })
  expect(stepNode).toMatchObject({
    id: expect.any(String),
    type: 'task',
    position: {
      x: CANVAS_NODE_ADD_BASE + CANVAS_LINKED_NODE_OFFSET_X,
      y: CANVAS_NODE_ADD_BASE,
    },
    data: { kind: 'task', workflow: { generation: 'image' } },
  })
  expect(document?.edges).toEqual([
    {
      id: expect.any(String),
      source: frameNode?.id,
      target: stepNode?.id,
    },
  ])
  expect(onOpenProject).toHaveBeenCalledWith('pc1')
})

test('removes a half-created workbench when the frame upload fails', async () => {
  vi.mocked(uploadPlaygroundAttachmentDirect).mockRejectedValue(
    new Error('upload failed')
  )
  const onOpenProject = vi.fn(async () => undefined)
  const { result } = renderHook(() =>
    useCanvasVideoFrameActions({ sourceTitle: 'Ocean', onOpenProject })
  )

  await act(async () => {
    await expect(
      result.current.createImageWorkbenchFromFrame(frame)
    ).rejects.toThrow('upload failed')
  })

  expect(deleteCanvasProject).toHaveBeenCalledWith('pc1')
  expect(updateCanvasProject).not.toHaveBeenCalled()
  expect(onOpenProject).not.toHaveBeenCalled()
})
