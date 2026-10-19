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
import type { ModelOption } from '@/features/playground/types'

import {
  CANVAS_IMAGE_TOOL_CAPABILITY_MESSAGES,
  CANVAS_IMAGE_TOOL_CROP_MIN_SIZE,
  CANVAS_IMAGE_TOOL_MAX_EDGE,
  CANVAS_IMAGE_TOOL_MESSAGES,
  CANVAS_IMAGE_TOOL_OUTPAINT_RATIOS,
  CANVAS_IMAGE_TOOL_STYLE_IMAGE_TYPES,
  CANVAS_IMAGE_TOOL_TITLES,
  CANVAS_IMAGE_TOOL_UPSCALE_FACTORS,
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES,
  type CanvasImageToolOutpaintRatio,
} from '../constants'
import type { CanvasNodeData } from '../types'
import {
  canvasWorkflowNodeLabel,
  type CanvasWorkflowModelCapability,
} from './canvas-workflow'

/** Which image tool a dialog runs; the titles double as translation keys. */
export type CanvasImageToolKind = keyof typeof CANVAS_IMAGE_TOOL_TITLES

/** The tools that call the relay instead of running in the browser. */
export const CANVAS_IMAGE_REMOTE_TOOLS = [
  'redraw',
  'outpaint',
  'backgroundRemoval',
  'styleReference',
] as const

export type CanvasImageRemoteToolKind =
  (typeof CANVAS_IMAGE_REMOTE_TOOLS)[number]

export type CanvasImageToolSupport = Record<CanvasImageRemoteToolKind, boolean>

export type CanvasImageSize = { width: number; height: number }

export type CanvasImageOutpaintLayout = CanvasImageSize & {
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
}

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

export type CanvasImageOutpaintInput = {
  prompt: string
  model: string
  ratio: CanvasImageToolOutpaintRatio
}

export type CanvasImageBackgroundRemovalInput = {
  prompt: string
  model: string
}

export type CanvasImageStyleReferenceInput = {
  prompt: string
  model: string
  styleImage: Blob
  styleFilename: string
  size?: string
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

/** The selected outpaint ratio, or the first one for an unknown value. */
export function canvasImageOutpaintRatio(
  value: string
): (typeof CANVAS_IMAGE_TOOL_OUTPAINT_RATIOS)[number] {
  return (
    CANVAS_IMAGE_TOOL_OUTPAINT_RATIOS.find(
      (option) => option.value === value
    ) ?? CANVAS_IMAGE_TOOL_OUTPAINT_RATIOS[0]
  )
}

/**
 * The canvas an outpainting request draws: the source keeps its pixels and is
 * centered, while the target ratio adds blank space around it. The result is
 * capped to the same longest edge as every other image operation, scaling the
 * source uniformly when the cap applies.
 */
export function canvasImageOutpaintLayout(
  source: CanvasImageSize,
  ratio: { width: number; height: number },
  maxEdge = CANVAS_IMAGE_TOOL_MAX_EDGE
): CanvasImageOutpaintLayout {
  const targetRatio = ratio.width / ratio.height
  let width: number
  let height: number
  if (source.width / source.height >= targetRatio) {
    width = source.width
    height = Math.max(1, Math.round(source.width / targetRatio))
  } else {
    height = source.height
    width = Math.max(1, Math.round(source.height * targetRatio))
  }
  const scale =
    Math.max(width, height) > maxEdge ? maxEdge / Math.max(width, height) : 1
  const outputWidth = Math.max(1, Math.round(width * scale))
  const outputHeight = Math.max(1, Math.round(height * scale))
  const sourceWidth = Math.min(
    outputWidth,
    Math.max(1, Math.round(source.width * scale))
  )
  const sourceHeight = Math.min(
    outputHeight,
    Math.max(1, Math.round(source.height * scale))
  )
  return {
    width: outputWidth,
    height: outputHeight,
    sourceX: Math.floor((outputWidth - sourceWidth) / 2),
    sourceY: Math.floor((outputHeight - sourceHeight) / 2),
    sourceWidth,
    sourceHeight,
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

/**
 * The relay tools one model supports, or null when the pricing catalog cannot
 * prove either way. A catalog row with endpoint metadata but no image tools is
 * a known gap; a row without any metadata keeps the controls enabled.
 */
export function canvasImageToolSupport(
  capability?: CanvasWorkflowModelCapability
): CanvasImageToolSupport | null {
  if (!capability) return null
  if (capability.imageTools) {
    return {
      redraw: capability.imageTools.edit === true,
      outpaint: capability.imageTools.outpaint === true,
      backgroundRemoval: capability.imageTools.backgroundRemoval === true,
      styleReference: capability.imageTools.styleReference === true,
    }
  }
  const endpoints = capability.endpointTypes ?? []
  const usageFields = capability.usageFields ?? []
  if (endpoints.length === 0 && usageFields.length === 0) return null
  return {
    redraw: false,
    outpaint: false,
    backgroundRemoval: false,
    styleReference: false,
  }
}

/** Whether a tool can run on one model; local tools always can. */
export function canvasImageToolModelSupports(
  tool: CanvasImageToolKind,
  capability?: CanvasWorkflowModelCapability
): boolean {
  if (tool === 'crop' || tool === 'upscale') return true
  const support = canvasImageToolSupport(capability)
  return support === null || support[tool]
}

/**
 * The model choices of one tool. Models without catalog metadata stay in the
 * list because the catalog may be disabled, while a known gap is filtered out.
 */
export function canvasImageToolModels(
  models: ModelOption[],
  capabilities: Record<string, CanvasWorkflowModelCapability> | undefined,
  tool: CanvasImageToolKind
): ModelOption[] {
  if (!capabilities || tool === 'crop' || tool === 'upscale') return models
  return models.filter((model) =>
    canvasImageToolModelSupports(tool, capabilities[model.value])
  )
}

/**
 * Remote tools no model of the current group advertises. An empty model list
 * or a missing catalog keeps every tool visible, matching the unknown-metadata
 * behavior of the workflow controls.
 */
export function canvasImageToolUnavailableKinds(
  models: ModelOption[],
  capabilities: Record<string, CanvasWorkflowModelCapability> | undefined
): CanvasImageRemoteToolKind[] {
  if (!capabilities || models.length === 0) return []
  return CANVAS_IMAGE_REMOTE_TOOLS.filter(
    (tool) => canvasImageToolModels(models, capabilities, tool).length === 0
  )
}

/** The tooltip reason of one hidden remote tool. */
export function canvasImageToolUnavailableReason(
  tool: CanvasImageRemoteToolKind
): string {
  return CANVAS_IMAGE_TOOL_CAPABILITY_MESSAGES[tool]
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

/** The first problem that stops an outpaint, or null when it is ready. */
export function canvasImageOutpaintError(input: {
  model: string
}): string | null {
  if (!input.model.trim()) {
    return CANVAS_IMAGE_TOOL_MESSAGES.OUTPAINT_MODEL_REQUIRED
  }
  return null
}

/** The first problem that stops background removal, or null when it is ready. */
export function canvasImageBackgroundRemovalError(input: {
  model: string
}): string | null {
  if (!input.model.trim()) {
    return CANVAS_IMAGE_TOOL_MESSAGES.BACKGROUND_REMOVAL_MODEL_REQUIRED
  }
  return null
}

/** The first problem with an uploaded style image, or null when it is usable. */
export function canvasImageStyleImageError(
  image: Pick<Blob, 'size' | 'type'> | null
): string | null {
  if (!image) return CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_REQUIRED
  if (!CANVAS_IMAGE_TOOL_STYLE_IMAGE_TYPES.includes(image.type)) {
    return CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_TYPE_UNSUPPORTED
  }
  if (image.size <= 0) {
    return CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_TYPE_UNSUPPORTED
  }
  if (image.size > CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES) {
    return CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_TOO_LARGE
  }
  return null
}

/** The first problem that stops a style reference, or null when it is ready. */
export function canvasImageStyleReferenceError(input: {
  prompt: string
  model: string
  styleImage: Pick<Blob, 'size' | 'type'> | null
}): string | null {
  const imageProblem = canvasImageStyleImageError(input.styleImage)
  if (imageProblem) return imageProblem
  if (!input.prompt.trim()) {
    return CANVAS_IMAGE_TOOL_MESSAGES.STYLE_REFERENCE_PROMPT_REQUIRED
  }
  if (!input.model.trim()) {
    return CANVAS_IMAGE_TOOL_MESSAGES.STYLE_REFERENCE_MODEL_REQUIRED
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
