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

import { uploadCanvasAttachment } from '@/features/playground/api'
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
  uploadCanvasAttachment: vi.fn(),
}))

afterEach(() => {
  clearPlaygroundAttachmentCache()
})

function pngFile(name: string, byteSize = 8): File {
  return new File([new Uint8Array(byteSize)], name, { type: 'image/png' })
}

function uploadReply(id: string, filename: string) {
  return {
    attachment: {
      id,
      clientKey: id,
      sessionId: 'pgc_1',
      mediaType: 'image/png',
      filename,
      byteSize: 8,
      createdAt: 0,
      updatedAt: 0,
    },
    created: true,
  }
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
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
      },
    },
    {
      kind: 'attachment',
      position: { x: 40 + CANVAS_DROP_NODE_OFFSET_X, y: 80 },
      data: {
        label: 'dog.png',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_2' },
      },
    },
  ])
  // The freshly uploaded bytes are primed, so the new node renders without
  // another round trip.
  expect(getPlaygroundAttachmentDataUrl('pgf_1')).toContain('data:image/png')
})
