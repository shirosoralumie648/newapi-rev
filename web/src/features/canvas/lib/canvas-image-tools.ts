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
import { playgroundAttachmentKind } from '@/features/playground/constants'

import {
  CANVAS_IMAGE_TOOL_CROP_MIN_SIZE,
  CANVAS_IMAGE_TOOL_MAX_EDGE,
  CANVAS_IMAGE_TOOL_MESSAGES,
  CANVAS_IMAGE_TOOL_TITLES,
  CANVAS_IMAGE_TOOL_UPSCALE_FACTORS,
} from '../constants'
import type { CanvasNodeData } from '../types'
import { canvasWorkflowNodeLabel } from './canvas-workflow'

/** Which image tool a dialog runs; the titles double as translation keys. */
export type CanvasImageToolKind = keyof typeof CANVAS_IMAGE_TOOL_TITLES

export type CanvasImageSize = { width: number; height: number }

/** Crop rectangle in source pixels. */
export type CanvasImageCropRect = {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasImagePoint = { x: number; y: number }

/** One painted mask stroke in source pixels; `size` is the brush diameter. */
export type CanvasImageMaskStroke = {
  size: number
  points: CanvasImagePoint[]
}

export type CanvasImageRedrawInput = {
  prompt: string
  model: string
  size?: string
  strokes: CanvasImageMaskStroke[]
}

/**
 * Where the image bytes of a tool node come from: an attachment behind the
 * owner-scoped content endpoint, or the image artifact of a settled task. Only
 * the source is described here; the caller reads the bytes through the
 * controlled endpoints, so the canvas never stores a URL.
 */
export type CanvasImageToolSource =
  | { kind: 'attachment'; sessionId: string; attachmentId: string }
  | { kind: 'task-result'; taskId: string; artifactKey?: string }

/** The image a tool node edits; null when the node carries no image bytes. */
export function canvasImageToolSource(
  data: CanvasNodeData
): CanvasImageToolSource | null {
  if (data.sourceDeleted === true) return null
  const reference = data.ref
  const isImage =
    data.kind === 'image' ||
    (data.kind === 'attachment' &&
      playgroundAttachmentKind(data.mediaType) === 'image')
  if (isImage && reference?.sessionId && reference.attachmentId) {
    return {
      kind: 'attachment',
      sessionId: reference.sessionId,
      attachmentId: reference.attachmentId,
    }
  }
  if (data.kind === 'task-result' && reference?.taskId) {
    return {
      kind: 'task-result',
      taskId: reference.taskId,
      ...(reference.taskArtifactKey
        ? { artifactKey: reference.taskArtifactKey }
        : {}),
    }
  }
  return null
}

/** The crop rectangle spanning two drag points, in the unit of the points. */
export function canvasImageCropRect(
  start: CanvasImagePoint,
  end: CanvasImagePoint
): CanvasImageCropRect {
  return {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y)),
  }
}

/** Keeps a crop rectangle inside the image bounds. */
export function clampCanvasImageCropRect(
  rect: CanvasImageCropRect,
  image: CanvasImageSize
): CanvasImageCropRect {
  const width = Math.max(
    0,
    Math.min(Math.round(rect.width), Math.round(image.width))
  )
  const height = Math.max(
    0,
    Math.min(Math.round(rect.height), Math.round(image.height))
  )
  const x = Math.max(
    0,
    Math.min(Math.round(rect.x), Math.round(image.width) - width)
  )
  const y = Math.max(
    0,
    Math.min(Math.round(rect.y), Math.round(image.height) - height)
  )
  return { x, y, width, height }
}

/** Source-length to display-length ratio; a degenerate measure keeps 1:1. */
export function canvasImageScale(
  displayLength: number,
  sourceLength: number
): number {
  if (!(displayLength > 0) || !(sourceLength > 0)) return 1
  return sourceLength / displayLength
}

/** Maps a crop rectangle from displayed pixels onto the source image. */
export function canvasImageCropRectFromDisplay(
  rect: CanvasImageCropRect,
  display: CanvasImageSize,
  image: CanvasImageSize
): CanvasImageCropRect {
  const scaleX = canvasImageScale(display.width, image.width)
  const scaleY = canvasImageScale(display.height, image.height)
  return clampCanvasImageCropRect(
    {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    },
    image
  )
}

/** Whether a crop is inside the image and reaches the minimum edge. */
export function isCanvasImageCropUsable(
  rect: CanvasImageCropRect,
  image: CanvasImageSize
): boolean {
  if (
    rect.width < CANVAS_IMAGE_TOOL_CROP_MIN_SIZE ||
    rect.height < CANVAS_IMAGE_TOOL_CROP_MIN_SIZE
  ) {
    return false
  }
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= image.width &&
    rect.y + rect.height <= image.height
  )
}

/** The image size a scale factor produces, at least one pixel per edge. */
export function scaledCanvasImageSize(
  image: CanvasImageSize,
  scale: number
): CanvasImageSize {
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  }
}

/** The scale that fits the longest edge into the limit; 1 when it already fits. */
export function canvasImageToolCanvasScale(
  image: CanvasImageSize,
  maxEdge = CANVAS_IMAGE_TOOL_MAX_EDGE
): number {
  const longest = Math.max(image.width, image.height)
  if (!(longest > maxEdge) || !(maxEdge > 0)) return 1
  return maxEdge / longest
}

/** The upscale factors whose output stays within the longest-edge limit. */
export function availableCanvasImageUpscaleFactors(
  image: CanvasImageSize,
  maxEdge = CANVAS_IMAGE_TOOL_MAX_EDGE
): number[] {
  return CANVAS_IMAGE_TOOL_UPSCALE_FACTORS.filter((factor) => {
    const scaled = scaledCanvasImageSize(image, factor)
    return Math.max(scaled.width, scaled.height) <= maxEdge
  })
}

/** Multiplies mask strokes by a scale factor applied to the image. */
export function scaleCanvasImageMaskStrokes(
  strokes: CanvasImageMaskStroke[],
  scale: number
): CanvasImageMaskStroke[] {
  if (scale === 1) return strokes
  return strokes.map((stroke) => ({
    size: Math.max(1, stroke.size * scale),
    points: stroke.points.map((point) => ({
      x: point.x * scale,
      y: point.y * scale,
    })),
  }))
}

/** Whether the user painted at least one point. */
export function canvasImageMaskHasPaint(
  strokes: CanvasImageMaskStroke[]
): boolean {
  return strokes.some((stroke) => stroke.points.length > 0)
}

/** The first problem that stops a redraw, or null when it is ready to send. */
export function canvasImageRedrawError(input: {
  prompt: string
  model: string
  strokes: CanvasImageMaskStroke[]
}): string | null {
  if (!canvasImageMaskHasPaint(input.strokes)) {
    return CANVAS_IMAGE_TOOL_MESSAGES.MASK_EMPTY
  }
  if (!input.prompt.trim()) {
    return CANVAS_IMAGE_TOOL_MESSAGES.PROMPT_REQUIRED
  }
  if (!input.model.trim()) {
    return CANVAS_IMAGE_TOOL_MESSAGES.MODEL_REQUIRED
  }
  return null
}

/** Filename of a tool result; only a safe ASCII base of the label survives. */
export function canvasImageToolFilename(
  label: string | undefined,
  suffix: string
): string {
  const base = (label ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80)
  return `${base || 'image'}-${suffix}.png`
}

/** The label of a tool result node: the source label plus what the tool did. */
export function canvasImageToolResultLabel(
  data: CanvasNodeData,
  suffix: string
): string {
  return `${canvasWorkflowNodeLabel(data)} · ${suffix}`
}
