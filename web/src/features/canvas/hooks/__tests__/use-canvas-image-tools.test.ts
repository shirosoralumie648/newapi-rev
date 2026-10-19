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
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { clearPlaygroundAttachmentCache } from '@/features/playground/lib/attachment-store'
import { uploadPlaygroundAttachmentDirect } from '@/features/playground/lib/attachment-upload'
import { api } from '@/lib/api'

import {
  CANVAS_ATTACHMENT_INLINE_MAX_BYTES,
  CANVAS_IMAGE_TOOL_MESSAGES,
  CANVAS_IMAGE_TOOL_PROMPTS,
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES,
} from '../../constants'
import {
  composeCanvasMask,
  composeCanvasOutpaint,
  cropCanvasImage,
  readCanvasImageSize,
  scaleCanvasImage,
} from '../../lib/canvas-image-render'
import type { CanvasFlowNode } from '../../types'
import {
  useCanvasImageTools,
  type UseCanvasImageToolsOptions,
} from '../use-canvas-image-tools'

vi.mock('@/features/playground/lib/attachment-upload', () => ({
  uploadPlaygroundAttachmentDirect: vi.fn(),
}))

vi.mock('../../lib/canvas-image-render', () => ({
  CanvasImageRenderError: class CanvasImageRenderError extends Error {
    readonly messageKey: string

    constructor(messageKey: string) {
      super(messageKey)
      this.name = 'CanvasImageRenderError'
      this.messageKey = messageKey
    }
  },
  composeCanvasMask: vi.fn(),
  composeCanvasOutpaint: vi.fn(),
  cropCanvasImage: vi.fn(),
  readCanvasImageSize: vi.fn(),
  scaleCanvasImage: vi.fn(),
}))

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42,
])
const CONTENT_URL = '/api/playground/sessions/pgc_1/attachments/pgf_1/content'
const UPLOAD_URL = '/api/playground/canvases/pgc_1/attachments'
const EDIT_URL = '/pg/images/edits'

function pngBlob(): Blob {
  return new Blob([PNG_BYTES], { type: 'image/png' })
}

function pngBase64(): string {
  return btoa(String.fromCharCode(...PNG_BYTES))
}

function attachmentReply(id: string) {
  return {
    data: {
      success: true,
      data: {
        created: true,
        id,
        session_id: 'pgc_1',
        media_type: 'image/png',
        filename: `${id}.png`,
        byte_size: PNG_BYTES.length,
        created_at: 0,
        updated_at: 0,
      },
    },
  }
}

function imageNode(): CanvasFlowNode {
  return {
    id: 'n1',
    type: 'image',
    position: { x: 100, y: 60 },
    data: {
      kind: 'image',
      label: 'photo',
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
    },
  }
}

function redrawInput() {
  return {
    prompt: 'add a hat',
    model: 'gpt-image-1',
    strokes: [
      {
        size: 24,
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ],
      },
    ],
  }
}

function useHarness(
  addLinkedNode?: () => string | null,
  modelCapabilities?: UseCanvasImageToolsOptions['modelCapabilities']
) {
  const link = vi.fn<UseCanvasImageToolsOptions['addLinkedNode']>(
    addLinkedNode ?? (() => 'node-new')
  )
  const hook = renderHook(() =>
    useCanvasImageTools({
      canvasId: 'pgc_1',
      group: 'default',
      ...(modelCapabilities ? { modelCapabilities } : {}),
      addLinkedNode: link,
    })
  )
  return { hook, link }
}

beforeEach(() => {
  clearPlaygroundAttachmentCache()
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:test',
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => undefined,
    })
  }
  vi.mocked(readCanvasImageSize).mockResolvedValue({ width: 100, height: 50 })
  vi.mocked(cropCanvasImage).mockResolvedValue({
    blob: pngBlob(),
    width: 100,
    height: 50,
  })
  vi.mocked(scaleCanvasImage).mockImplementation(async (_source, factor) => ({
    blob: pngBlob(),
    width: Math.max(1, Math.round(100 * factor)),
    height: Math.max(1, Math.round(50 * factor)),
  }))
  vi.mocked(composeCanvasMask).mockResolvedValue(pngBlob())
  vi.mocked(composeCanvasOutpaint).mockResolvedValue({
    blob: pngBlob(),
    mask: pngBlob(),
    width: 100,
    height: 100,
    sourceX: 0,
    sourceY: 25,
    sourceWidth: 100,
    sourceHeight: 50,
  })
  vi.mocked(uploadPlaygroundAttachmentDirect).mockResolvedValue({
    id: 'pgf_direct',
    sessionId: 'pgc_1',
    mediaType: 'image/png',
    filename: 'photo-cropped.png',
    byteSize: PNG_BYTES.length,
    createdAt: 0,
    updatedAt: 0,
  })
})

afterEach(() => {
  cleanup()
  clearPlaygroundAttachmentCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('opening a tool reads the node bytes and measures the preview', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(async () => ({ data: pngBlob() }))
  const { hook } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'crop'))
  expect(hook.result.current.tool).toBe('crop')

  await waitFor(() => expect(hook.result.current.source).not.toBeNull())
  expect(hook.result.current.source).toContain('data:image/png;base64,')
  expect(hook.result.current.sourceSize).toEqual({ width: 100, height: 50 })
  expect(get).toHaveBeenCalledWith(
    CONTENT_URL,
    expect.objectContaining({ responseType: 'blob' })
  )
})

test('cropping stores the rendered bytes and links a new image node', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === UPLOAD_URL) return attachmentReply('pgf_crop')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'crop'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.crop({
      x: 10,
      y: 20,
      width: 80,
      height: 30,
    })
  })

  expect(applied).toBe(true)
  expect(cropCanvasImage).toHaveBeenCalledWith(
    expect.stringContaining('data:image/png;base64,'),
    { x: 10, y: 20, width: 80, height: 30 }
  )
  expect(post).toHaveBeenCalledWith(
    UPLOAD_URL,
    {
      client_key: expect.any(String),
      media_type: 'image/png',
      filename: 'photo-cropped.png',
      data: expect.stringMatching(/^[A-Za-z0-9+/=]+$/),
    },
    expect.anything()
  )
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    {
      label: 'photo · cropped',
      mediaType: 'image/png',
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_crop' },
    },
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
  expect(hook.result.current.tool).toBeNull()
})

test('a crop below the minimum edge is refused without uploading', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post')
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'crop'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = true
  await act(async () => {
    applied = await hook.result.current.crop({
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    })
  })

  expect(applied).toBe(false)
  expect(hook.result.current.message).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.CROP_TOO_SMALL
  )
  expect(cropCanvasImage).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
  expect(link).not.toHaveBeenCalled()
})

test('a local upscale stores the scaled bytes and names the factor', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === UPLOAD_URL) return attachmentReply('pgf_up')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'upscale'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.upscale(3)
  })

  expect(applied).toBe(true)
  expect(scaleCanvasImage).toHaveBeenCalledWith(
    expect.stringContaining('data:image/png;base64,'),
    3
  )
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({ label: 'photo · upscaled ×3' }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})

test('an upscale beyond the edge limit is refused', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  vi.mocked(readCanvasImageSize).mockResolvedValue({
    width: 4096,
    height: 4096,
  })
  const { hook } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'upscale'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = true
  await act(async () => {
    applied = await hook.result.current.upscale(2)
  })

  expect(applied).toBe(false)
  expect(hook.result.current.message).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.UPSCALE_UNAVAILABLE
  )
  expect(scaleCanvasImage).not.toHaveBeenCalled()
})

test('a redraw sends the image and mask to the edits route and stores the returned image', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === EDIT_URL) return { data: { data: [{ b64_json: pngBase64() }] } }
    if (url === UPLOAD_URL) return attachmentReply('pgf_edit')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'redraw'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.redraw({
      prompt: 'add a hat',
      model: 'gpt-image-1',
      size: '1024x1024',
      strokes: [
        {
          size: 24,
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 20 },
          ],
        },
      ],
    })
  })

  expect(applied).toBe(true)
  expect(composeCanvasMask).toHaveBeenCalledWith(100, 50, [
    {
      size: 24,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
    },
  ])
  const edit = post.mock.calls.find(([url]) => url === EDIT_URL)
  expect(edit).toBeTruthy()
  const form = edit?.[1] as FormData
  expect(form.get('model')).toBe('gpt-image-1')
  expect(form.get('prompt')).toBe('add a hat')
  expect(form.get('size')).toBe('1024x1024')
  expect(form.get('image')).toBeInstanceOf(Blob)
  expect(form.get('mask')).toBeInstanceOf(Blob)
  expect(edit?.[2]).toMatchObject({
    headers: { 'X-Playground-Group': 'default' },
  })
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({
      label: 'photo · redrawn',
      mediaType: 'image/png',
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_edit' },
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})

test('a redraw answered by a task plugin records a task result node', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === EDIT_URL) {
      return { data: { success: true, data: { task_id: 'task-9' } } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'redraw'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.redraw(redrawInput())
  })

  expect(applied).toBe(true)
  expect(link).toHaveBeenCalledWith(
    'task-result',
    'n1',
    expect.objectContaining({
      label: 'photo · redrawn',
      ref: { taskId: 'task-9' },
      workflow: expect.objectContaining({
        status: 'succeeded',
        model: 'gpt-image-1',
        inputText: 'add a hat',
      }),
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
  expect(hook.result.current.tool).toBeNull()
})

test('an outpaint composes a mask and posts the target ratio', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === EDIT_URL) return { data: { data: [{ b64_json: pngBase64() }] } }
    if (url === UPLOAD_URL) return attachmentReply('pgf_outpaint')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'outpaint'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.outpaint({
      prompt: 'add sky',
      model: 'gpt-image-1',
      ratio: '1:1',
    })
  })

  expect(applied).toBe(true)
  expect(composeCanvasOutpaint).toHaveBeenCalledWith(
    expect.stringContaining('data:image/png;base64,'),
    expect.objectContaining({ value: '1:1', size: '1024x1024' })
  )
  const edit = post.mock.calls.find(([url]) => url === EDIT_URL)
  expect(edit).toBeTruthy()
  const form = edit?.[1] as FormData
  expect(form.get('model')).toBe('gpt-image-1')
  expect(form.get('prompt')).toBe('add sky')
  expect(form.get('size')).toBe('1024x1024')
  expect(form.get('image')).toBeInstanceOf(Blob)
  expect(form.get('mask')).toBeInstanceOf(Blob)
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({
      label: 'photo · outpainted',
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_outpaint' },
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})

test('background removal posts a transparent request without a mask', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === EDIT_URL) return { data: { data: [{ b64_json: pngBase64() }] } }
    if (url === UPLOAD_URL) return attachmentReply('pgf_nobg')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'backgroundRemoval'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.backgroundRemoval({
      prompt: '',
      model: 'gpt-image-1',
    })
  })

  expect(applied).toBe(true)
  const edit = post.mock.calls.find(([url]) => url === EDIT_URL)
  const form = edit?.[1] as FormData
  expect(form.get('model')).toBe('gpt-image-1')
  expect(form.get('prompt')).toBe(CANVAS_IMAGE_TOOL_PROMPTS.BACKGROUND_REMOVAL)
  expect(form.get('size')).toBe('auto')
  expect(form.get('background')).toBe('transparent')
  expect(form.get('output_format')).toBe('png')
  expect(form.get('image')).toBeInstanceOf(Blob)
  expect(form.get('mask')).toBeNull()
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({
      label: 'photo · background removed',
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_nobg' },
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})

test('a style reference posts both images with the prompt', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === EDIT_URL) return { data: { data: [{ b64_json: pngBase64() }] } }
    if (url === UPLOAD_URL) return attachmentReply('pgf_style')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'styleReference'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.styleReference({
      prompt: 'paint it blue',
      model: 'gpt-image-1',
      styleImage: new File(['style'], 'style.png', { type: 'image/png' }),
      styleFilename: 'style.png',
      size: '1024x1024',
    })
  })

  expect(applied).toBe(true)
  const edit = post.mock.calls.find(([url]) => url === EDIT_URL)
  const form = edit?.[1] as FormData
  expect(form.get('model')).toBe('gpt-image-1')
  expect(form.get('prompt')).toBe('paint it blue')
  expect(form.get('size')).toBe('1024x1024')
  expect(form.getAll('image[]')).toHaveLength(2)
  expect(form.get('mask')).toBeNull()
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({
      label: 'photo · style referenced',
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_style' },
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})

test('a tool refused by the model capability never sends a request', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post')
  const { hook, link } = useHarness(undefined, {
    'gpt-image-1': {
      imageTools: {
        edit: true,
        outpaint: false,
        backgroundRemoval: false,
        styleReference: false,
      },
    },
  })

  act(() => hook.result.current.open(imageNode(), 'outpaint'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = true
  await act(async () => {
    applied = await hook.result.current.outpaint({
      prompt: '',
      model: 'gpt-image-1',
      ratio: '1:1',
    })
  })

  expect(applied).toBe(false)
  expect(hook.result.current.message).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.TOOL_UNSUPPORTED
  )
  expect(composeCanvasOutpaint).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
  expect(link).not.toHaveBeenCalled()
})

test('a full canvas reports the node limit after the bytes are stored', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === UPLOAD_URL) return attachmentReply('pgf_crop')
    throw new Error(`Unexpected POST ${url}`)
  })
  const { hook, link } = useHarness(() => null)

  act(() => hook.result.current.open(imageNode(), 'crop'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = true
  await act(async () => {
    applied = await hook.result.current.crop({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    })
  })

  expect(applied).toBe(false)
  expect(hook.result.current.message).toBe(
    CANVAS_IMAGE_TOOL_MESSAGES.NODE_LIMIT
  )
  expect(post).toHaveBeenCalled()
  expect(link).toHaveBeenCalled()
})

test('a failed read reports the source as unreadable and closes the tool', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => {
    throw new Error('network down')
  })
  const { hook } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'crop'))

  await waitFor(() =>
    expect(hook.result.current.message).toBe(
      CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_UNREADABLE
    )
  )
  expect(hook.result.current.tool).toBeNull()
})

test('a source above the read limit reports the size problem', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({
    data: new Blob(
      [new Uint8Array(CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES + 1)],
      {
        type: 'image/png',
      }
    ),
  }))
  const { hook } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'crop'))

  await waitFor(() =>
    expect(hook.result.current.message).toBe(
      CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_TOO_LARGE
    )
  )
  expect(hook.result.current.tool).toBeNull()
})

test('a result above the inline limit streams through the reservation flow', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  const post = vi.spyOn(api, 'post')
  vi.mocked(cropCanvasImage).mockResolvedValue({
    blob: new Blob([new Uint8Array(CANVAS_ATTACHMENT_INLINE_MAX_BYTES + 1)], {
      type: 'image/png',
    }),
    width: 10,
    height: 10,
  })
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'crop'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.crop({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    })
  })

  expect(applied).toBe(true)
  expect(post).not.toHaveBeenCalled()
  expect(uploadPlaygroundAttachmentDirect).toHaveBeenCalledWith(
    { canvasId: 'pgc_1' },
    expect.any(File)
  )
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_direct' },
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})

test('a provider URL result is fetched once without credentials and never stored', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ({ data: pngBlob() }))
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === EDIT_URL) {
      return { data: { data: [{ url: 'https://provider.example/out.png' }] } }
    }
    if (url === UPLOAD_URL) return attachmentReply('pgf_url')
    throw new Error(`Unexpected POST ${url}`)
  })
  const fetchMock = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => PNG_BYTES.buffer,
  }))
  vi.stubGlobal('fetch', fetchMock)
  const { hook, link } = useHarness()

  act(() => hook.result.current.open(imageNode(), 'redraw'))
  await waitFor(() => expect(hook.result.current.source).not.toBeNull())

  let applied = false
  await act(async () => {
    applied = await hook.result.current.redraw(redrawInput())
  })

  expect(applied).toBe(true)
  expect(fetchMock).toHaveBeenCalledWith('https://provider.example/out.png', {
    credentials: 'omit',
  })
  expect(JSON.stringify(link.mock.calls[0]?.[2])).not.toContain(
    'provider.example'
  )
  expect(link).toHaveBeenCalledWith(
    'image',
    'n1',
    expect.objectContaining({
      ref: { sessionId: 'pgc_1', attachmentId: 'pgf_url' },
    }),
    { x: 100 + CANVAS_LINKED_NODE_OFFSET_X, y: 60 }
  )
})
