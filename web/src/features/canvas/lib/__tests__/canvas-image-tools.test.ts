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
import { expect, test } from 'vitest'

import {
  CANVAS_IMAGE_TOOL_CAPABILITY_MESSAGES,
  CANVAS_IMAGE_TOOL_CROP_MIN_SIZE,
  CANVAS_IMAGE_TOOL_MESSAGES,
  CANVAS_IMAGE_TOOL_OUTPAINT_RATIOS,
} from '../../constants'
import type { CanvasNodeData } from '../../types'
import {
  availableCanvasImageUpscaleFactors,
  canvasImageBackgroundRemovalError,
  canvasImageCropRect,
  canvasImageCropRectFromDisplay,
  canvasImageMaskHasPaint,
  canvasImageOutpaintError,
  canvasImageOutpaintLayout,
  canvasImageOutpaintRatio,
  canvasImageRedrawError,
  canvasImageScale,
  canvasImageStyleImageError,
  canvasImageStyleReferenceError,
  canvasImageToolCanvasScale,
  canvasImageToolFilename,
  canvasImageToolModels,
  canvasImageToolResultLabel,
  canvasImageToolSource,
  canvasImageToolSupport,
  canvasImageToolUnavailableKinds,
  canvasImageToolUnavailableReason,
  clampCanvasImageCropRect,
  isCanvasImageCropUsable,
  scaledCanvasImageSize,
  scaleCanvasImageMaskStrokes,
} from '../canvas-image-tools'

function nodeData(overrides: Partial<CanvasNodeData>): CanvasNodeData {
  return { kind: 'image', ...overrides }
}

test('an image tool reads bytes from attachments and task artifacts only', () => {
  expect(
    canvasImageToolSource(
      nodeData({
        kind: 'image',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
      })
    )
  ).toEqual({ kind: 'attachment', sessionId: 'pgc_1', attachmentId: 'pgf_1' })

  expect(
    canvasImageToolSource(
      nodeData({
        kind: 'attachment',
        mediaType: 'image/png',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_2' },
      })
    )
  ).toEqual({ kind: 'attachment', sessionId: 'pgc_1', attachmentId: 'pgf_2' })

  expect(
    canvasImageToolSource(
      nodeData({
        kind: 'attachment',
        mediaType: 'video/mp4',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_3' },
      })
    )
  ).toBeNull()

  expect(
    canvasImageToolSource(
      nodeData({
        kind: 'task-result',
        ref: { taskId: 'task-1', taskArtifactKey: 'out-1' },
      })
    )
  ).toEqual({ kind: 'task-result', taskId: 'task-1', artifactKey: 'out-1' })

  expect(
    canvasImageToolSource(
      nodeData({
        sourceDeleted: true,
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
      })
    )
  ).toBeNull()
})

test('a drag builds a normalized crop rectangle', () => {
  expect(canvasImageCropRect({ x: 100, y: 80 }, { x: 40, y: 30 })).toEqual({
    x: 40,
    y: 30,
    width: 60,
    height: 50,
  })
})

test('a crop rectangle stays inside the image', () => {
  expect(
    clampCanvasImageCropRect(
      { x: -10, y: -5, width: 2000, height: 2000 },
      { width: 1000, height: 500 }
    )
  ).toEqual({ x: 0, y: 0, width: 1000, height: 500 })
  expect(
    clampCanvasImageCropRect(
      { x: 950, y: 450, width: 100, height: 100 },
      { width: 1000, height: 500 }
    )
  ).toEqual({ x: 900, y: 400, width: 100, height: 100 })
})

test('a displayed crop selection maps onto the source pixels', () => {
  expect(
    canvasImageCropRectFromDisplay(
      { x: 10, y: 10, width: 100, height: 50 },
      { width: 200, height: 100 },
      { width: 1000, height: 500 }
    )
  ).toEqual({ x: 50, y: 50, width: 500, height: 250 })
  expect(
    canvasImageCropRectFromDisplay(
      { x: 190, y: 95, width: 50, height: 20 },
      { width: 200, height: 100 },
      { width: 1000, height: 500 }
    )
  ).toEqual({ x: 750, y: 400, width: 250, height: 100 })
})

test('a crop is usable only inside the image and above the minimum edge', () => {
  const image = { width: 100, height: 100 }
  expect(
    isCanvasImageCropUsable(
      {
        x: 0,
        y: 0,
        width: CANVAS_IMAGE_TOOL_CROP_MIN_SIZE,
        height: CANVAS_IMAGE_TOOL_CROP_MIN_SIZE,
      },
      image
    )
  ).toBe(true)
  expect(
    isCanvasImageCropUsable(
      {
        x: 0,
        y: 0,
        width: CANVAS_IMAGE_TOOL_CROP_MIN_SIZE - 1,
        height: 40,
      },
      image
    )
  ).toBe(false)
  expect(
    isCanvasImageCropUsable({ x: 95, y: 0, width: 8, height: 8 }, image)
  ).toBe(false)
})

test('a degenerate display measure keeps the source scale', () => {
  expect(canvasImageScale(200, 1000)).toBe(5)
  expect(canvasImageScale(0, 1000)).toBe(1)
  expect(canvasImageScale(200, 0)).toBe(1)
})

test('the canvas scale fits the longest edge into the limit', () => {
  expect(canvasImageToolCanvasScale({ width: 8192, height: 4096 })).toBe(0.5)
  expect(canvasImageToolCanvasScale({ width: 1024, height: 768 })).toBe(1)
  expect(scaledCanvasImageSize({ width: 1000, height: 500 }, 0.5)).toEqual({
    width: 500,
    height: 250,
  })
  expect(scaledCanvasImageSize({ width: 1, height: 1 }, 0.1)).toEqual({
    width: 1,
    height: 1,
  })
})

test('upscale factors stop before the longest-edge limit', () => {
  expect(
    availableCanvasImageUpscaleFactors({ width: 512, height: 512 })
  ).toEqual([2, 3, 4])
  expect(
    availableCanvasImageUpscaleFactors({ width: 2048, height: 1024 })
  ).toEqual([2])
  expect(
    availableCanvasImageUpscaleFactors({ width: 1024, height: 2048 })
  ).toEqual([2])
  expect(
    availableCanvasImageUpscaleFactors({ width: 4096, height: 4096 })
  ).toEqual([])
})

test('mask strokes follow the scale the image was drawn at', () => {
  const strokes = [{ size: 24, points: [{ x: 10, y: 20 }] }]
  expect(scaleCanvasImageMaskStrokes(strokes, 1)).toBe(strokes)
  expect(scaleCanvasImageMaskStrokes(strokes, 0.5)).toEqual([
    { size: 12, points: [{ x: 5, y: 10 }] },
  ])
})

test('a redraw requires painted pixels, a prompt and a model', () => {
  const strokes = [{ size: 24, points: [{ x: 1, y: 2 }] }]
  expect(canvasImageMaskHasPaint([])).toBe(false)
  expect(
    canvasImageRedrawError({
      prompt: 'add a hat',
      model: 'gpt-image-1',
      strokes: [],
    })
  ).toBe(CANVAS_IMAGE_TOOL_MESSAGES.MASK_EMPTY)
  expect(
    canvasImageRedrawError({
      prompt: '   ',
      model: 'gpt-image-1',
      strokes,
    })
  ).toBe(CANVAS_IMAGE_TOOL_MESSAGES.PROMPT_REQUIRED)
  expect(
    canvasImageRedrawError({ prompt: 'add a hat', model: ' ', strokes })
  ).toBe(CANVAS_IMAGE_TOOL_MESSAGES.MODEL_REQUIRED)
  expect(
    canvasImageRedrawError({
      prompt: 'add a hat',
      model: 'gpt-image-1',
      strokes,
    })
  ).toBeNull()
})

test('a result filename is a safe ASCII base plus the tool suffix', () => {
  expect(canvasImageToolFilename('photo.png', 'cropped')).toBe(
    'photo-cropped.png'
  )
  expect(canvasImageToolFilename('  ', 'upscaled-2x')).toBe(
    'image-upscaled-2x.png'
  )
  expect(canvasImageToolFilename('红色图片', 'redrawn')).toBe(
    'image-redrawn.png'
  )
  expect(canvasImageToolFilename(undefined, 'edit-mask')).toBe(
    'image-edit-mask.png'
  )
})

test('a result label names the source node and the tool', () => {
  expect(
    canvasImageToolResultLabel(nodeData({ label: 'photo' }), 'cropped')
  ).toBe('photo · cropped')
  expect(canvasImageToolResultLabel(nodeData({}), 'redrawn')).toBe(
    'Image · redrawn'
  )
})

test('an outpaint centers the source in the selected aspect ratio', () => {
  expect(canvasImageOutpaintRatio('3:2')).toEqual(
    CANVAS_IMAGE_TOOL_OUTPAINT_RATIOS[1]
  )
  expect(
    canvasImageOutpaintLayout(
      { width: 1000, height: 500 },
      { width: 1, height: 1 }
    )
  ).toEqual({
    width: 1000,
    height: 1000,
    sourceX: 0,
    sourceY: 250,
    sourceWidth: 1000,
    sourceHeight: 500,
  })
  expect(
    canvasImageOutpaintLayout(
      { width: 500, height: 1000 },
      { width: 3, height: 2 }
    )
  ).toEqual({
    width: 1500,
    height: 1000,
    sourceX: 500,
    sourceY: 0,
    sourceWidth: 500,
    sourceHeight: 1000,
  })
})

test('an outpaint respects the longest-edge limit', () => {
  expect(
    canvasImageOutpaintLayout(
      { width: 8192, height: 4096 },
      { width: 1, height: 1 }
    )
  ).toEqual({
    width: 4096,
    height: 4096,
    sourceX: 0,
    sourceY: 1024,
    sourceWidth: 4096,
    sourceHeight: 2048,
  })
})

test('creative tools require a model and a usable style image', () => {
  expect(canvasImageOutpaintError({ model: ' ' })).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.OUTPAINT_MODEL_REQUIRED
  )
  expect(canvasImageOutpaintError({ model: 'gpt-image-1' })).toBeNull()
  expect(canvasImageBackgroundRemovalError({ model: '' })).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.BACKGROUND_REMOVAL_MODEL_REQUIRED
  )
  expect(canvasImageBackgroundRemovalError({ model: 'gpt-image-1' })).toBeNull()
  expect(canvasImageStyleImageError(null)).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_REQUIRED
  )
  expect(
    canvasImageStyleImageError({ type: 'image/svg+xml', size: 1024 })
  ).toBe(CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_TYPE_UNSUPPORTED)
  expect(
    canvasImageStyleImageError({ type: 'image/png', size: 8 * 1024 * 1024 + 1 })
  ).toBe(CANVAS_IMAGE_TOOL_MESSAGES.STYLE_IMAGE_TOO_LARGE)
  expect(
    canvasImageStyleReferenceError({
      prompt: '  ',
      model: 'gpt-image-1',
      styleImage: { type: 'image/png', size: 1024 },
    })
  ).toBe(CANVAS_IMAGE_TOOL_MESSAGES.STYLE_REFERENCE_PROMPT_REQUIRED)
  expect(
    canvasImageStyleReferenceError({
      prompt: 'paint it blue',
      model: 'gpt-image-1',
      styleImage: { type: 'image/png', size: 1024 },
    })
  ).toBeNull()
})

test('remote image tools follow the advertised model capabilities', () => {
  const models = [
    { label: 'GPT Image', value: 'gpt-image-1' },
    { label: 'GPT-4o', value: 'gpt-4o' },
  ]
  const capabilities = {
    'gpt-image-1': {
      imageTools: {
        edit: true,
        outpaint: true,
        backgroundRemoval: true,
        styleReference: true,
      },
    },
    'gpt-4o': { endpointTypes: ['openai'], usageFields: [] },
  }

  expect(canvasImageToolSupport(capabilities['gpt-image-1'])).toEqual({
    redraw: true,
    outpaint: true,
    backgroundRemoval: true,
    styleReference: true,
  })
  expect(canvasImageToolSupport(capabilities['gpt-4o'])).toEqual({
    redraw: false,
    outpaint: false,
    backgroundRemoval: false,
    styleReference: false,
  })
  expect(
    canvasImageToolSupport({ endpointTypes: ['image-generation'] })
  ).toEqual({
    redraw: false,
    outpaint: false,
    backgroundRemoval: false,
    styleReference: false,
  })
  expect(canvasImageToolSupport({})).toBeNull()
  expect(canvasImageToolModels(models, capabilities, 'outpaint')).toEqual([
    models[0],
  ])
  expect(canvasImageToolModels(models, undefined, 'outpaint')).toEqual(models)
  expect(canvasImageToolUnavailableKinds(models, capabilities)).toEqual([])
  expect(
    canvasImageToolUnavailableKinds(models, {
      ...capabilities,
      'gpt-image-1': {
        imageTools: {
          edit: true,
          outpaint: true,
          backgroundRemoval: false,
          styleReference: true,
        },
      },
    })
  ).toEqual(['backgroundRemoval'])
  expect(canvasImageToolUnavailableKinds([], capabilities)).toEqual([])
  expect(canvasImageToolUnavailableKinds(models, undefined)).toEqual([])
  expect(canvasImageToolUnavailableReason('backgroundRemoval')).toBe(
    CANVAS_IMAGE_TOOL_CAPABILITY_MESSAGES.backgroundRemoval
  )
})
