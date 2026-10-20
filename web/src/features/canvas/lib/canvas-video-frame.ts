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
import { PLAYGROUND_ATTACHMENT_MAX_BYTES } from '@/features/playground/constants'

/** Longest edge of a captured frame; larger videos are scaled down to it. */
export const CANVAS_VIDEO_FRAME_MAX_EDGE = 2048
/** JPEG quality of the captured frame. */
export const CANVAS_VIDEO_FRAME_QUALITY = 0.92

/** Translation keys of the frame capture failures. */
export const CANVAS_VIDEO_FRAME_MESSAGES = {
  NOT_READY: 'The video frame is not ready yet.',
  CAPTURE_FAILED: 'The frame could not be captured.',
  TOO_LARGE: 'The captured frame is larger than the attachment limit.',
  ADD_FAILED: 'The captured frame could not be added to the canvas.',
} as const

export class CanvasVideoFrameError extends Error {
  readonly messageKey: string

  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'CanvasVideoFrameError'
    this.messageKey = messageKey
  }
}

export type CanvasVideoFrame = {
  blob: Blob
  file: File
  /** Playback position the frame was taken from, in seconds. */
  seconds: number
}

/**
 * The pixel size of a captured frame. Videos above the longest-edge budget are
 * scaled down proportionally, so a 4K frame never allocates a 4K canvas.
 */
export function canvasVideoFrameSize(
  width: number,
  height: number,
  maxEdge: number = CANVAS_VIDEO_FRAME_MAX_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
  }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** A language-neutral file name the attachment upload keeps verbatim. */
export function canvasVideoFrameFileName(seconds: number): string {
  const position = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return `video-frame-${position.toFixed(1)}s.jpg`
}

function frameBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
          return
        }
        reject(
          new CanvasVideoFrameError(CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED)
        )
      },
      type,
      quality
    )
  })
}

/**
 * Captures the frame the user currently sees. The video element is same-origin
 * through the gateway content endpoint; a provider URL that taints the canvas
 * is reported as a capture failure instead of storing an empty image.
 */
export async function captureCanvasVideoFrame(
  video: HTMLVideoElement
): Promise<CanvasVideoFrame> {
  if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new CanvasVideoFrameError(CANVAS_VIDEO_FRAME_MESSAGES.NOT_READY)
  }
  const size = canvasVideoFrameSize(video.videoWidth, video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  try {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new CanvasVideoFrameError(
        CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED
      )
    }
    context.drawImage(video, 0, 0, size.width, size.height)
    const blob = await frameBlob(
      canvas,
      'image/jpeg',
      CANVAS_VIDEO_FRAME_QUALITY
    )
    if (blob.size <= 0) {
      throw new CanvasVideoFrameError(
        CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED
      )
    }
    if (blob.size > PLAYGROUND_ATTACHMENT_MAX_BYTES) {
      throw new CanvasVideoFrameError(CANVAS_VIDEO_FRAME_MESSAGES.TOO_LARGE)
    }
    const seconds = Number.isFinite(video.currentTime)
      ? Math.max(0, video.currentTime)
      : 0
    return {
      blob,
      file: new File([blob], canvasVideoFrameFileName(seconds), {
        type: 'image/jpeg',
      }),
      seconds,
    }
  } catch (error) {
    if (error instanceof CanvasVideoFrameError) throw error
    throw new CanvasVideoFrameError(CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED)
  }
}
