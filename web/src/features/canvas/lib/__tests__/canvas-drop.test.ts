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
import { afterEach, expect, test, vi } from 'vitest'

import {
  beginPlaygroundUpload,
  cancelPlaygroundUpload,
  completePlaygroundUpload,
  putPlaygroundUploadContent,
  uploadCanvasAttachment,
} from '@/features/playground/api'
import {
  clearPlaygroundAttachmentCache,
  getPlaygroundAttachmentDataUrl,
} from '@/features/playground/lib/attachment-store'
import { PLAYGROUND_ATTACHMENT_ERRORS } from '@/features/playground/lib/attachment-upload'

import {
  CANVAS_DROP_MESSAGES,
  CANVAS_DROP_NODE_OFFSET_X,
} from '../../constants'
import { CanvasDropError, canvasDropEntries } from '../canvas-drop'

vi.mock('@/features/playground/api', () => ({
  beginPlaygroundUpload: vi.fn(),
  cancelPlaygroundUpload: vi.fn(),
  completePlaygroundUpload: vi.fn(),
  playgroundAttachmentContentUrl: vi.fn(),
  putPlaygroundUploadContent: vi.fn(),
  uploadCanvasAttachment: vi.fn(),
  uploadPlaygroundAttachment: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  clearPlaygroundAttachmentCache()
})

function pngFile(name: string, byteSize = 8): File {
  return new File([new Uint8Array(byteSize)], name, { type: 'image/png' })
}

function uploadReply(id: string, filename: string, mediaType = 'image/png') {
  return {
    attachment: {
      id,
      clientKey: id,
      sessionId: 'pgc_1',
      mediaType,
      filename,
      byteSize: 8,
      createdAt: 0,
      updatedAt: 0,
    },
    created: true,
  }
}

function pdfFile(name: string, byteSize = 15): File {
  return new File([new Uint8Array(byteSize)], name, {
    type: 'application/pdf',
  })
}

test('rejects a drop that has no files or an unsupported file type', async () => {
  await expect(canvasDropEntries('pgc_1', { x: 0, y: 0 }, [])).rejects.toThrow(
    CANVAS_DROP_MESSAGES.UNSUPPORTED_TYPE
  )
  const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
  await expect(
    canvasDropEntries('pgc_1', { x: 0, y: 0 }, [text])
  ).rejects.toBeInstanceOf(CanvasDropError)
  expect(uploadCanvasAttachment).not.toHaveBeenCalled()
})

test('rejects too many files and an oversized file before uploading', async () => {
  const many = Array.from({ length: 9 }, (_, index) => pngFile(`f${index}.png`))
  await expect(
    canvasDropEntries('pgc_1', { x: 0, y: 0 }, many)
  ).rejects.toThrow(CANVAS_DROP_MESSAGES.TOO_MANY)

  const huge = pngFile('huge.png')
  Object.defineProperty(huge, 'size', { value: 9 * 1024 * 1024 })
  await expect(
    canvasDropEntries('pgc_1', { x: 0, y: 0 }, [huge])
  ).rejects.toThrow(PLAYGROUND_ATTACHMENT_ERRORS.TOO_LARGE)
  expect(uploadCanvasAttachment).not.toHaveBeenCalled()
})

test('uploads dropped images into the canvas partition and lays them out', async () => {
  vi.mocked(uploadCanvasAttachment)
    .mockResolvedValueOnce(uploadReply('pgf_1', 'cat.png'))
    .mockResolvedValueOnce(uploadReply('pgf_2', 'dog.png'))

  const entries = await canvasDropEntries('pgc_1', { x: 40, y: 80 }, [
    pngFile('cat.png'),
    pngFile('dog.png'),
  ])

  expect(uploadCanvasAttachment).toHaveBeenCalledWith(
    'pgc_1',
    expect.objectContaining({ mediaType: 'image/png', filename: 'cat.png' })
  )
  expect(entries).toEqual([
    {
      kind: 'attachment',
      position: { x: 40, y: 80 },
      data: {
        label: 'cat.png',
        mediaType: 'image/png',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
      },
    },
    {
      kind: 'attachment',
      position: { x: 40 + CANVAS_DROP_NODE_OFFSET_X, y: 80 },
      data: {
        label: 'dog.png',
        mediaType: 'image/png',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_2' },
      },
    },
  ])
  // The freshly uploaded bytes are primed, so the new node renders without
  // another round trip.
  expect(getPlaygroundAttachmentDataUrl('pgf_1')).toContain('data:image/png')
})

test('sends a dropped PDF through the reservation flow and keeps its media type', async () => {
  vi.mocked(beginPlaygroundUpload).mockResolvedValueOnce({
    id: 'pgu_1',
    mode: 'relay',
  })
  vi.mocked(putPlaygroundUploadContent).mockResolvedValueOnce(undefined)
  vi.mocked(completePlaygroundUpload).mockResolvedValueOnce({
    attachment: {
      id: 'pgf_pdf',
      sessionId: 'pgc_1',
      mediaType: 'application/pdf',
      filename: 'notes.pdf',
      byteSize: 15,
      createdAt: 0,
      updatedAt: 0,
    },
    created: true,
  })

  const file = pdfFile('notes.pdf')
  const entries = await canvasDropEntries('pgc_1', { x: 0, y: 0 }, [file])

  expect(beginPlaygroundUpload).toHaveBeenCalledWith(
    expect.objectContaining({
      canvasId: 'pgc_1',
      mediaType: 'application/pdf',
      filename: 'notes.pdf',
      byteSize: 15,
    }),
    undefined
  )
  expect(putPlaygroundUploadContent).toHaveBeenCalledWith(
    'pgu_1',
    file,
    'application/pdf',
    undefined
  )
  expect(completePlaygroundUpload).toHaveBeenCalledWith('pgu_1', undefined)
  expect(uploadCanvasAttachment).not.toHaveBeenCalled()
  expect(entries).toEqual([
    {
      kind: 'attachment',
      position: { x: 0, y: 0 },
      data: {
        label: 'notes.pdf',
        mediaType: 'application/pdf',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_pdf' },
      },
    },
  ])
})

test('falls back to the relay route when the presigned PUT is refused', async () => {
  vi.mocked(beginPlaygroundUpload).mockResolvedValueOnce({
    id: 'pgu_2',
    mode: 'presigned',
    url: 'https://bucket.example/presigned',
    headers: { 'Content-Type': 'video/mp4' },
  })
  vi.mocked(putPlaygroundUploadContent).mockResolvedValueOnce(undefined)
  vi.mocked(completePlaygroundUpload).mockResolvedValueOnce({
    attachment: {
      id: 'pgf_video',
      sessionId: 'pgc_1',
      mediaType: 'video/mp4',
      filename: 'clip.mp4',
      byteSize: 4,
      createdAt: 0,
      updatedAt: 0,
    },
    created: true,
  })
  const fetchMock = vi.fn().mockResolvedValue({ ok: false })
  vi.stubGlobal('fetch', fetchMock)

  const file = new File([new Uint8Array(4)], 'clip.mp4', { type: 'video/mp4' })
  await canvasDropEntries('pgc_1', { x: 0, y: 0 }, [file])

  expect(fetchMock).toHaveBeenCalledWith(
    'https://bucket.example/presigned',
    expect.objectContaining({ method: 'PUT', body: file })
  )
  expect(putPlaygroundUploadContent).toHaveBeenCalledWith(
    'pgu_2',
    file,
    'video/mp4',
    undefined
  )
  expect(completePlaygroundUpload).toHaveBeenCalledWith('pgu_2', undefined)
  expect(cancelPlaygroundUpload).not.toHaveBeenCalled()
})

test('cancels the reservation when the bytes cannot be uploaded', async () => {
  vi.mocked(beginPlaygroundUpload).mockResolvedValueOnce({
    id: 'pgu_3',
    mode: 'relay',
  })
  vi.mocked(putPlaygroundUploadContent).mockRejectedValueOnce(
    new Error('network down')
  )
  vi.mocked(cancelPlaygroundUpload).mockResolvedValueOnce(undefined)

  await expect(
    canvasDropEntries('pgc_1', { x: 0, y: 0 }, [pdfFile('notes.pdf')])
  ).rejects.toThrow('network down')
  expect(cancelPlaygroundUpload).toHaveBeenCalledWith('pgu_3')
  expect(completePlaygroundUpload).not.toHaveBeenCalled()
})

test('rejects an oversized video before creating a reservation', async () => {
  const huge = new File([new Uint8Array(4)], 'clip.mp4', { type: 'video/mp4' })
  Object.defineProperty(huge, 'size', { value: 65 * 1024 * 1024 })
  await expect(
    canvasDropEntries('pgc_1', { x: 0, y: 0 }, [huge])
  ).rejects.toThrow(PLAYGROUND_ATTACHMENT_ERRORS.TOO_LARGE)
  expect(beginPlaygroundUpload).not.toHaveBeenCalled()
})
