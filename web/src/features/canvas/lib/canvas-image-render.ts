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
import {
  CANVAS_IMAGE_TOOL_MAX_EDGE,
  CANVAS_IMAGE_TOOL_MESSAGES,
} from '../constants'
import {
  canvasImageToolCanvasScale,
  scaledCanvasImageSize,
  type CanvasImageCropRect,
  type CanvasImageMaskStroke,
  type CanvasImageSize,
} from './canvas-image-tools'

/** The bytes one render produced plus the size they were drawn at. */
export interface CanvasImageRendered {
  blob: Blob
  width: number
  height: number
}

/**
 * A failure of one browser-side image operation. The message is the
 * translation key of the problem, so the editor reports it like any other
 * canvas message without inventing a server answer.
 */
export class CanvasImageRenderError extends Error {
  readonly messageKey: string

  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'CanvasImageRenderError'
    this.messageKey = messageKey
  }
}

/** Decodes a data URL into an image element the render functions draw from. */
function loadCanvasImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', () => {
      reject(
        new CanvasImageRenderError(CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_UNREADABLE)
      )
    })
    image.src = source
  })
}

function imageNaturalSize(image: HTMLImageElement): CanvasImageSize {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }
}

/** A canvas and its drawing context; a missing context is a render failure. */
function createRenderCanvas(
  width: number,
  height: number
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new CanvasImageRenderError(CANVAS_IMAGE_TOOL_MESSAGES.FAILED)
  }
  return { canvas, context }
}

/** Encodes a canvas as PNG; the tool results are stored as PNG attachments. */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      reject(new CanvasImageRenderError(CANVAS_IMAGE_TOOL_MESSAGES.FAILED))
    }, 'image/png')
  })
}

/** Measures one data-URL image so a dialog can lay out its controls. */
export async function readCanvasImageSize(
  source: string
): Promise<CanvasImageSize> {
  return imageNaturalSize(await loadCanvasImage(source))
}

/**
 * Crops one region out of the source image, capped to the longest-edge limit.
 * The browser smooths the downscale when the region itself is larger than the
 * limit, so a crop of a huge photo still returns storable bytes.
 */
export async function cropCanvasImage(
  source: string,
  rect: CanvasImageCropRect,
  maxEdge = CANVAS_IMAGE_TOOL_MAX_EDGE
): Promise<CanvasImageRendered> {
  const image = await loadCanvasImage(source)
  const output = scaledCanvasImageSize(
    rect,
    canvasImageToolCanvasScale(rect, maxEdge)
  )
  const { canvas, context } = createRenderCanvas(output.width, output.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    output.width,
    output.height
  )
  return { blob: await canvasToBlob(canvas), ...output }
}

/**
 * Draws the whole source image at a scale factor (a local upscale, or the
 * downscale a redraw request needs), capped to the longest-edge limit. The
 * returned size is what a caller composing a matching mask must use.
 */
export async function scaleCanvasImage(
  source: string,
  scale: number,
  maxEdge = CANVAS_IMAGE_TOOL_MAX_EDGE
): Promise<CanvasImageRendered> {
  const image = await loadCanvasImage(source)
  const size = imageNaturalSize(image)
  const scaled = scaledCanvasImageSize(size, scale)
  const output = scaledCanvasImageSize(
    scaled,
    canvasImageToolCanvasScale(scaled, maxEdge)
  )
  const { canvas, context } = createRenderCanvas(output.width, output.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    0,
    0,
    size.width,
    size.height,
    0,
    0,
    output.width,
    output.height
  )
  return { blob: await canvasToBlob(canvas), ...output }
}

/**
 * Paints the mask of a redraw at the given size following the convention the
 * relay and the upstream edit API expect: an opaque surface where the source is
 * kept, fully transparent over the painted strokes where the model may change
 * the image. A single point becomes a dot of the brush diameter.
 */
export async function composeCanvasMask(
  width: number,
  height: number,
  strokes: CanvasImageMaskStroke[]
): Promise<Blob> {
  const { canvas, context } = createRenderCanvas(width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'destination-out'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = '#000000'
  context.fillStyle = '#000000'
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue
    const lineWidth = Math.max(1, stroke.size)
    if (stroke.points.length === 1) {
      const point = stroke.points[0]
      context.beginPath()
      context.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2)
      context.fill()
      continue
    }
    context.lineWidth = lineWidth
    context.beginPath()
    context.moveTo(stroke.points[0].x, stroke.points[0].y)
    for (const point of stroke.points.slice(1)) {
      context.lineTo(point.x, point.y)
    }
    context.stroke()
  }
  return canvasToBlob(canvas)
}
