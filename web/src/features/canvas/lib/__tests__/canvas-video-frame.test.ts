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

import { PLAYGROUND_ATTACHMENT_MAX_BYTES } from '@/features/playground/constants'

import {
  CANVAS_VIDEO_FRAME_MAX_EDGE,
  CANVAS_VIDEO_FRAME_MESSAGES,
  canvasVideoFrameFileName,
  canvasVideoFrameSize,
  captureCanvasVideoFrame,
} from '../canvas-video-frame'

const originalCreateElement = document.createElement.bind(document)

function mockCanvas(blob: Blob | null) {
  const context = { drawImage: vi.fn() }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(blob)),
  }
  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions
  ) => {
    if (tagName === 'canvas') return canvas as unknown as HTMLCanvasElement
    return originalCreateElement(tagName, options)
  }) as typeof document.createElement)
  return { canvas, context }
}

function mockVideo(
  width: number,
  height: number,
  currentTime: number,
  readyState = 4
): HTMLVideoElement {
  return {
    readyState,
    videoWidth: width,
    videoHeight: height,
    currentTime,
  } as unknown as HTMLVideoElement
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('scales a captured frame down to the longest-edge budget', () => {
  expect(canvasVideoFrameSize(3840, 2160)).toEqual({
    width: 2048,
    height: 1152,
  })
  expect(canvasVideoFrameSize(640, 360)).toEqual({ width: 640, height: 360 })
  expect(canvasVideoFrameSize(1000, 4000)).toEqual({
    width: 512,
    height: CANVAS_VIDEO_FRAME_MAX_EDGE,
  })
})

test('names the frame with its playback position', () => {
  expect(canvasVideoFrameFileName(12.34)).toBe('video-frame-12.3s.jpg')
  expect(canvasVideoFrameFileName(-2)).toBe('video-frame-0.0s.jpg')
  expect(canvasVideoFrameFileName(Number.NaN)).toBe('video-frame-0.0s.jpg')
})

test('captures the current frame as an image attachment', async () => {
  const blob = new Blob(['frame'], { type: 'image/jpeg' })
  const { canvas, context } = mockCanvas(blob)
  const video = mockVideo(3840, 2160, 12.34)

  const frame = await captureCanvasVideoFrame(video)

  expect(canvas.width).toBe(2048)
  expect(canvas.height).toBe(1152)
  expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 2048, 1152)
  expect(frame.blob).toBe(blob)
  expect(frame.seconds).toBe(12.34)
  expect(frame.file.name).toBe('video-frame-12.3s.jpg')
  expect(frame.file.type).toBe('image/jpeg')
})

test('rejects a video that has not decoded a frame yet', async () => {
  mockCanvas(new Blob(['frame'], { type: 'image/jpeg' }))

  await expect(
    captureCanvasVideoFrame(mockVideo(1920, 1080, 0, 1))
  ).rejects.toMatchObject({ messageKey: CANVAS_VIDEO_FRAME_MESSAGES.NOT_READY })
})

test('rejects an empty canvas capture and an oversized frame', async () => {
  mockCanvas(null)
  await expect(
    captureCanvasVideoFrame(mockVideo(1920, 1080, 0))
  ).rejects.toMatchObject({
    messageKey: CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED,
  })

  vi.restoreAllMocks()
  mockCanvas({
    size: PLAYGROUND_ATTACHMENT_MAX_BYTES + 1,
    type: 'image/jpeg',
  } as Blob)
  await expect(
    captureCanvasVideoFrame(mockVideo(1920, 1080, 0))
  ).rejects.toMatchObject({ messageKey: CANVAS_VIDEO_FRAME_MESSAGES.TOO_LARGE })
})
