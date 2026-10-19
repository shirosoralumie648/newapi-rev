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
import { nanoid } from 'nanoid'
import { useCallback, useRef, useState } from 'react'

import {
  uploadCanvasAttachment,
  type PlaygroundServerAttachment,
} from '@/features/playground/api'
import {
  submitImageEdit,
  type PlaygroundImageGenerationOutcome,
  type PlaygroundImageResult,
} from '@/features/playground/generation-api'
import {
  blobToDataUrl,
  primePlaygroundAttachment,
} from '@/features/playground/lib/attachment-store'
import { uploadPlaygroundAttachmentDirect } from '@/features/playground/lib/attachment-upload'
import {
  getServerErrorMessageKey,
  getServerErrorSources,
} from '@/lib/server-error-message'

import {
  CANVAS_ATTACHMENT_INLINE_MAX_BYTES,
  CANVAS_IMAGE_TOOL_MESSAGES,
  CANVAS_IMAGE_TOOL_PROMPTS,
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_WORKFLOW_MESSAGES,
} from '../constants'
import {
  CanvasImageRenderError,
  composeCanvasMask,
  composeCanvasOutpaint,
  cropCanvasImage,
  readCanvasImageSize,
  scaleCanvasImage,
} from '../lib/canvas-image-render'
import {
  availableCanvasImageUpscaleFactors,
  canvasImageBackgroundRemovalError,
  canvasImageOutpaintError,
  canvasImageOutpaintRatio,
  canvasImageRedrawError,
  canvasImageStyleReferenceError,
  canvasImageToolCanvasScale,
  canvasImageToolFilename,
  canvasImageToolModelSupports,
  canvasImageToolResultLabel,
  canvasImageToolSource,
  isCanvasImageCropUsable,
  scaleCanvasImageMaskStrokes,
  type CanvasImageBackgroundRemovalInput,
  type CanvasImageCropRect,
  type CanvasImageOutpaintInput,
  type CanvasImageRedrawInput,
  type CanvasImageRemoteToolKind,
  type CanvasImageSize,
  type CanvasImageStyleReferenceInput,
  type CanvasImageToolKind,
} from '../lib/canvas-image-tools'
import type {
  CanvasWorkflowImageSource,
  CanvasWorkflowModelCapability,
} from '../lib/canvas-workflow'
import {
  CanvasWorkflowImageError,
  readCanvasWorkflowImage,
} from '../lib/canvas-workflow-images'
import type { CanvasFlowNode, CanvasNodeData, CanvasNodeKind } from '../types'

/**
 * A local image tool failure. The message is the translation key of the
 * problem, so the editor reports it like any other canvas message without
 * inventing a server answer.
 */
class CanvasImageToolError extends Error {
  readonly messageKey: string

  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'CanvasImageToolError'
    this.messageKey = messageKey
  }
}

type CanvasImageEditResultOptions = {
  model: string
  prompt: string
  size?: string
  labelSuffix: string
  filenameSuffix: string
}

/**
 * The untranslated English source of a failure: the local problem keys first
 * (the bytes could not be read, rendered or stored), then the server
 * `message_key`, the stable code mapping and the raw message, so a relay error
 * keeps its specific reason.
 */
function imageToolErrorText(error: unknown): string {
  if (
    error instanceof CanvasImageToolError ||
    error instanceof CanvasImageRenderError
  ) {
    return error.messageKey
  }
  // The reader's keys are phrased for a connected reference image, while a
  // tool reads the selected node itself.
  if (error instanceof CanvasWorkflowImageError) {
    return error.messageKey === CANVAS_WORKFLOW_MESSAGES.IMAGE_TOO_LARGE
      ? CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_TOO_LARGE
      : CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_UNREADABLE
  }
  for (const source of getServerErrorSources(error)) {
    if (typeof source.message_key === 'string' && source.message_key.trim()) {
      return source.message_key
    }
  }
  const key = getServerErrorMessageKey(error)
  if (key) return key
  for (const source of getServerErrorSources(error)) {
    const message = source.message
    if (typeof message !== 'string' || !message.trim()) continue
    if (message === 'success') continue
    if (/^\s*(?:<!doctype|<html[\s>])/i.test(message)) continue
    return message
  }
  return CANVAS_IMAGE_TOOL_MESSAGES.FAILED
}

// The leading bytes of the image types a canvas attachment may declare. The
// server re-checks the signature against the declared media type, so the type
// is sniffed from the bytes instead of trusting the provider.
const CANVAS_IMAGE_PNG_SIGNATURE = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]

function sniffImageMediaType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= CANVAS_IMAGE_PNG_SIGNATURE.length &&
    CANVAS_IMAGE_PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6))
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const head = String.fromCharCode(...bytes.slice(0, 4))
    const format = String.fromCharCode(...bytes.slice(8, 12))
    if (head === 'RIFF' && format === 'WEBP') return 'image/webp'
  }
  return null
}

function decodeBase64ImageBytes(source: string): Uint8Array<ArrayBuffer> {
  const separator = source.startsWith('data:') ? source.indexOf(',') : -1
  const payload = separator >= 0 ? source.slice(separator + 1) : source
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function fetchImageBytes(
  url: string | undefined
): Promise<Uint8Array<ArrayBuffer>> {
  const target = url?.trim()
  if (!target) {
    throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.RESULT_UNREADABLE)
  }
  // A provider URL is outside the gateway and is never stored on the canvas:
  // the bytes are fetched once, without credentials, and the URL is dropped.
  const response = await fetch(target, { credentials: 'omit' })
  if (!response.ok) {
    throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.RESULT_UNREADABLE)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Decodes the selected node's data URL into the bytes the multipart edit body
 * carries. The dialog keeps the source as a data URL for preview, while
 * `submitImageEdit` appends Blobs to its FormData.
 */
function sourceImageBlob(source: string): Blob {
  const separator = source.startsWith('data:') ? source.indexOf(',') : -1
  if (separator < 0) {
    throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_UNREADABLE)
  }
  const mediaType = source.slice(5, separator).split(';')[0]?.trim()
  return new Blob([decodeBase64ImageBytes(source)], {
    type: mediaType || 'image/png',
  })
}

/** Decodes one returned image into the bytes a canvas attachment stores. */
async function imageResultToBlob(image: PlaygroundImageResult): Promise<Blob> {
  try {
    const bytes = image.b64Json
      ? decodeBase64ImageBytes(image.b64Json)
      : await fetchImageBytes(image.url)
    const mediaType = sniffImageMediaType(bytes)
    if (bytes.length === 0 || !mediaType) {
      throw new CanvasImageToolError(
        CANVAS_IMAGE_TOOL_MESSAGES.RESULT_UNREADABLE
      )
    }
    return new Blob([bytes], { type: mediaType })
  } catch (error) {
    if (error instanceof CanvasImageToolError) throw error
    throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.RESULT_UNREADABLE)
  }
}

/**
 * Stores one tool result as a canvas attachment. A small image keeps the
 * one-request base64 path and is primed for an instant preview; a larger one
 * streams through the reservation flow so the bytes never travel inside a JSON
 * body.
 */
async function storeCanvasImage(
  canvasId: string,
  blob: Blob,
  filename: string
): Promise<PlaygroundServerAttachment> {
  if (blob.size <= 0 || !blob.type) {
    throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.FAILED)
  }
  if (blob.size <= CANVAS_ATTACHMENT_INLINE_MAX_BYTES) {
    let dataUrl: string
    try {
      dataUrl = await blobToDataUrl(blob)
    } catch {
      throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.FAILED)
    }
    const separator = dataUrl.indexOf(',')
    if (separator === -1) {
      throw new CanvasImageToolError(CANVAS_IMAGE_TOOL_MESSAGES.FAILED)
    }
    const { attachment } = await uploadCanvasAttachment(canvasId, {
      clientKey: nanoid(),
      mediaType: blob.type,
      filename,
      data: dataUrl.slice(separator + 1),
    })
    primePlaygroundAttachment(attachment.id, dataUrl)
    return attachment
  }
  return uploadPlaygroundAttachmentDirect(
    { canvasId },
    new File([blob], filename, { type: blob.type })
  )
}

export interface UseCanvasImageToolsOptions {
  /** Canvas the tool results are attached to. */
  canvasId: string
  /** User group a redraw runs in; empty uses the account group. */
  group: string
  /** Model capability metadata used to reject a tool on an unsupported model. */
  modelCapabilities?: Record<string, CanvasWorkflowModelCapability>
  /** Adds a node fed by an existing one; null when the canvas is full. */
  addLinkedNode: (
    kind: CanvasNodeKind,
    sourceId: string,
    data: Partial<CanvasNodeData>,
    position: { x: number; y: number }
  ) => string | null
}

export interface UseCanvasImageToolsResult {
  /** The open dialog, or null when none is open. */
  tool: CanvasImageToolKind | null
  /** Data URL of the selected image; null while it is still being read. */
  source: string | null
  sourceSize: CanvasImageSize | null
  busy: boolean
  /** Untranslated feedback the editor reports once; null when clean. */
  message: string | null
  open: (node: CanvasFlowNode, tool: CanvasImageToolKind) => void
  close: () => void
  clearMessage: () => void
  crop: (rect: CanvasImageCropRect) => Promise<boolean>
  redraw: (input: CanvasImageRedrawInput) => Promise<boolean>
  upscale: (factor: number) => Promise<boolean>
  outpaint: (input: CanvasImageOutpaintInput) => Promise<boolean>
  backgroundRemoval: (
    input: CanvasImageBackgroundRemovalInput
  ) => Promise<boolean>
  styleReference: (input: CanvasImageStyleReferenceInput) => Promise<boolean>
}

/**
 * The image tools of one canvas: crop and local upscale transform the selected
 * node's bytes in the browser and save the result as a new canvas attachment;
 * redraw composes a mask and sends the image plus mask through the existing
 * /pg/images/edits relay route. Every result becomes a new node linked to the
 * node the tool started from, so billing, permissions and error reporting stay
 * the ordinary pipeline.
 */
export function useCanvasImageTools(
  options: UseCanvasImageToolsOptions
): UseCanvasImageToolsResult {
  const [tool, setTool] = useState<CanvasImageToolKind | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const [sourceSize, setSourceSize] = useState<CanvasImageSize | null>(null)

  const optionsRef = useRef(options)
  optionsRef.current = options
  const targetRef = useRef<CanvasFlowNode | null>(null)
  const sourceRef = useRef<string | null>(null)
  const sourceSizeRef = useRef<CanvasImageSize | null>(null)
  const readIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)

  const clearMessage = useCallback(() => setMessage(null), [])

  /** Rejects a relay tool before a request when the model cannot route it. */
  const modelSupportsTool = useCallback(
    (tool: CanvasImageRemoteToolKind, model: string): boolean => {
      const capability = optionsRef.current.modelCapabilities?.[model]
      if (canvasImageToolModelSupports(tool, capability)) return true
      setMessage(CANVAS_IMAGE_TOOL_MESSAGES.TOOL_UNSUPPORTED)
      return false
    },
    []
  )

  const close = useCallback(() => {
    readIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    targetRef.current = null
    sourceRef.current = null
    sourceSizeRef.current = null
    busyRef.current = false
    setTool(null)
    setSource(null)
    setSourceSize(null)
    setBusy(false)
  }, [])

  /**
   * Opens one tool on a node and reads its bytes through the owner-scoped
   * endpoints. A read failure reports the problem and does not open a dialog
   * with nothing to edit.
   */
  const open = useCallback(
    (node: CanvasFlowNode, nextTool: CanvasImageToolKind) => {
      const toolSource = canvasImageToolSource(node.data)
      if (!toolSource) {
        setMessage(CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_UNREADABLE)
        return
      }
      readIdRef.current += 1
      const readId = readIdRef.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      targetRef.current = node
      sourceRef.current = null
      sourceSizeRef.current = null
      busyRef.current = false
      setTool(nextTool)
      setSource(null)
      setSourceSize(null)
      setBusy(false)
      const reference: CanvasWorkflowImageSource =
        toolSource.kind === 'attachment'
          ? {
              nodeId: node.id,
              kind: 'attachment',
              sessionId: toolSource.sessionId,
              attachmentId: toolSource.attachmentId,
            }
          : {
              nodeId: node.id,
              kind: 'task-result',
              taskId: toolSource.taskId,
              ...(toolSource.artifactKey
                ? { artifactKey: toolSource.artifactKey }
                : {}),
            }
      void (async () => {
        try {
          const dataUrl = await readCanvasWorkflowImage(
            reference,
            controller.signal
          )
          const size = await readCanvasImageSize(dataUrl)
          if (readIdRef.current !== readId) return
          sourceRef.current = dataUrl
          sourceSizeRef.current = size
          setSource(dataUrl)
          setSourceSize(size)
        } catch (error) {
          if (readIdRef.current !== readId || controller.signal.aborted) return
          setMessage(imageToolErrorText(error))
          close()
        }
      })()
    },
    [close]
  )

  /** Stores one rendered result and links its new node to the source node. */
  const storeResult = useCallback(
    async (blob: Blob, filename: string, label: string): Promise<boolean> => {
      const node = targetRef.current
      if (!node) return false
      const attachment = await storeCanvasImage(
        optionsRef.current.canvasId,
        blob,
        filename
      )
      const created = optionsRef.current.addLinkedNode(
        'image',
        node.id,
        {
          label,
          mediaType: attachment.mediaType,
          ref: { sessionId: attachment.sessionId, attachmentId: attachment.id },
        },
        { x: node.position.x + CANVAS_LINKED_NODE_OFFSET_X, y: node.position.y }
      )
      if (!created) {
        setMessage(CANVAS_IMAGE_TOOL_MESSAGES.NODE_LIMIT)
        return false
      }
      close()
      return true
    },
    [close]
  )

  /**
   * Turns one image-edit outcome into a linked node. A task-plugin model answers
   * with a durable task id; every other edit returns images whose bytes are
   * stored as a new attachment. Both paths add the same visible result node.
   */
  const completeEdit = useCallback(
    async (
      node: CanvasFlowNode,
      outcome: PlaygroundImageGenerationOutcome,
      resultOptions: CanvasImageEditResultOptions
    ): Promise<boolean> => {
      const label = canvasImageToolResultLabel(
        node.data,
        resultOptions.labelSuffix
      )
      if (outcome.kind === 'task') {
        const created = optionsRef.current.addLinkedNode(
          'task-result',
          node.id,
          {
            label,
            ref: { taskId: outcome.taskId },
            workflow: {
              status: 'succeeded',
              model: resultOptions.model,
              inputText: resultOptions.prompt,
              ...(resultOptions.size ? { size: resultOptions.size } : {}),
              updatedAt: Date.now(),
            },
          },
          {
            x: node.position.x + CANVAS_LINKED_NODE_OFFSET_X,
            y: node.position.y,
          }
        )
        if (!created) {
          setMessage(CANVAS_IMAGE_TOOL_MESSAGES.NODE_LIMIT)
          return false
        }
        close()
        return true
      }
      const result = outcome.images[0]
      if (!result) {
        setMessage(CANVAS_IMAGE_TOOL_MESSAGES.RESULT_UNREADABLE)
        return false
      }
      const blob = await imageResultToBlob(result)
      return await storeResult(
        blob,
        canvasImageToolFilename(node.data.label, resultOptions.filenameSuffix),
        label
      )
    },
    [close, storeResult]
  )

  const crop = useCallback(
    async (rect: CanvasImageCropRect): Promise<boolean> => {
      const node = targetRef.current
      const image = sourceRef.current
      const size = sourceSizeRef.current
      if (!node || !image || !size || busyRef.current) return false
      if (!isCanvasImageCropUsable(rect, size)) {
        setMessage(CANVAS_IMAGE_TOOL_MESSAGES.CROP_TOO_SMALL)
        return false
      }
      busyRef.current = true
      setBusy(true)
      try {
        const rendered = await cropCanvasImage(image, rect)
        return await storeResult(
          rendered.blob,
          canvasImageToolFilename(node.data.label, 'cropped'),
          canvasImageToolResultLabel(node.data, 'cropped')
        )
      } catch (error) {
        setMessage(imageToolErrorText(error))
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [storeResult]
  )

  const upscale = useCallback(
    async (factor: number): Promise<boolean> => {
      const node = targetRef.current
      const image = sourceRef.current
      const size = sourceSizeRef.current
      if (!node || !image || !size || busyRef.current) return false
      if (!availableCanvasImageUpscaleFactors(size).includes(factor)) {
        setMessage(CANVAS_IMAGE_TOOL_MESSAGES.UPSCALE_UNAVAILABLE)
        return false
      }
      busyRef.current = true
      setBusy(true)
      try {
        const rendered = await scaleCanvasImage(image, factor)
        return await storeResult(
          rendered.blob,
          canvasImageToolFilename(node.data.label, `upscaled-${factor}x`),
          canvasImageToolResultLabel(node.data, `upscaled ×${factor}`)
        )
      } catch (error) {
        setMessage(imageToolErrorText(error))
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [storeResult]
  )

  const redraw = useCallback(
    async (input: CanvasImageRedrawInput): Promise<boolean> => {
      const node = targetRef.current
      const image = sourceRef.current
      const size = sourceSizeRef.current
      if (!node || !image || !size || busyRef.current) return false
      const problem = canvasImageRedrawError(input)
      if (problem) {
        setMessage(problem)
        return false
      }
      const model = input.model.trim()
      if (!modelSupportsTool('redraw', model)) return false
      busyRef.current = true
      setBusy(true)
      try {
        // The image and its mask must share dimensions, so both are drawn at
        // the same capped scale the request carries.
        const scale = canvasImageToolCanvasScale(size)
        const rendered = await scaleCanvasImage(image, scale)
        const mask = await composeCanvasMask(
          rendered.width,
          rendered.height,
          scaleCanvasImageMaskStrokes(input.strokes, scale)
        )
        const prompt = input.prompt.trim()
        const outcome = await submitImageEdit({
          model,
          prompt,
          image: rendered.blob,
          imageFilename: canvasImageToolFilename(node.data.label, 'edit'),
          mask,
          maskFilename: canvasImageToolFilename(node.data.label, 'edit-mask'),
          ...(optionsRef.current.group
            ? { group: optionsRef.current.group }
            : {}),
          ...(input.size ? { size: input.size } : {}),
        })
        return await completeEdit(node, outcome, {
          model,
          prompt,
          ...(input.size ? { size: input.size } : {}),
          labelSuffix: 'redrawn',
          filenameSuffix: 'redrawn',
        })
      } catch (error) {
        setMessage(imageToolErrorText(error))
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [completeEdit, modelSupportsTool]
  )

  const outpaint = useCallback(
    async (input: CanvasImageOutpaintInput): Promise<boolean> => {
      const node = targetRef.current
      const image = sourceRef.current
      if (!node || !image || busyRef.current) return false
      const problem = canvasImageOutpaintError(input)
      if (problem) {
        setMessage(problem)
        return false
      }
      const model = input.model.trim()
      if (!modelSupportsTool('outpaint', model)) return false
      busyRef.current = true
      setBusy(true)
      try {
        const ratio = canvasImageOutpaintRatio(input.ratio)
        const rendered = await composeCanvasOutpaint(image, ratio)
        const prompt = input.prompt.trim() || CANVAS_IMAGE_TOOL_PROMPTS.OUTPAINT
        const outcome = await submitImageEdit({
          model,
          prompt,
          image: rendered.blob,
          imageFilename: canvasImageToolFilename(node.data.label, 'outpaint'),
          mask: rendered.mask,
          maskFilename: canvasImageToolFilename(
            node.data.label,
            'outpaint-mask'
          ),
          size: ratio.size,
          ...(optionsRef.current.group
            ? { group: optionsRef.current.group }
            : {}),
        })
        return await completeEdit(node, outcome, {
          model,
          prompt,
          size: ratio.size,
          labelSuffix: 'outpainted',
          filenameSuffix: 'outpainted',
        })
      } catch (error) {
        setMessage(imageToolErrorText(error))
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [completeEdit, modelSupportsTool]
  )

  const backgroundRemoval = useCallback(
    async (input: CanvasImageBackgroundRemovalInput): Promise<boolean> => {
      const node = targetRef.current
      const image = sourceRef.current
      if (!node || !image || busyRef.current) return false
      const problem = canvasImageBackgroundRemovalError(input)
      if (problem) {
        setMessage(problem)
        return false
      }
      const model = input.model.trim()
      if (!modelSupportsTool('backgroundRemoval', model)) return false
      busyRef.current = true
      setBusy(true)
      try {
        const prompt =
          input.prompt.trim() || CANVAS_IMAGE_TOOL_PROMPTS.BACKGROUND_REMOVAL
        const outcome = await submitImageEdit({
          model,
          prompt,
          image: sourceImageBlob(image),
          imageFilename: canvasImageToolFilename(
            node.data.label,
            'background-source'
          ),
          size: 'auto',
          background: 'transparent',
          outputFormat: 'png',
          ...(optionsRef.current.group
            ? { group: optionsRef.current.group }
            : {}),
        })
        return await completeEdit(node, outcome, {
          model,
          prompt,
          size: 'auto',
          labelSuffix: 'background removed',
          filenameSuffix: 'background-removed',
        })
      } catch (error) {
        setMessage(imageToolErrorText(error))
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [completeEdit, modelSupportsTool]
  )

  const styleReference = useCallback(
    async (input: CanvasImageStyleReferenceInput): Promise<boolean> => {
      const node = targetRef.current
      const image = sourceRef.current
      if (!node || !image || busyRef.current) return false
      const problem = canvasImageStyleReferenceError(input)
      if (problem) {
        setMessage(problem)
        return false
      }
      const model = input.model.trim()
      if (!modelSupportsTool('styleReference', model)) return false
      busyRef.current = true
      setBusy(true)
      try {
        const prompt = input.prompt.trim()
        const outcome = await submitImageEdit({
          model,
          prompt,
          image: sourceImageBlob(image),
          imageFilename: canvasImageToolFilename(
            node.data.label,
            'style-source'
          ),
          references: [
            {
              blob: input.styleImage,
              filename: input.styleFilename.trim() || 'style.png',
            },
          ],
          ...(input.size ? { size: input.size } : {}),
          ...(optionsRef.current.group
            ? { group: optionsRef.current.group }
            : {}),
        })
        return await completeEdit(node, outcome, {
          model,
          prompt,
          ...(input.size ? { size: input.size } : {}),
          labelSuffix: 'style referenced',
          filenameSuffix: 'style-referenced',
        })
      } catch (error) {
        setMessage(imageToolErrorText(error))
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [completeEdit, modelSupportsTool]
  )

  return {
    tool,
    source,
    sourceSize,
    busy,
    message,
    open,
    close,
    clearMessage,
    crop,
    redraw,
    upscale,
    outpaint,
    backgroundRemoval,
    styleReference,
  }
}
