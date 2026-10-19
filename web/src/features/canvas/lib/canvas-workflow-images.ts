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
  getPlaygroundAttachmentContent,
  playgroundAttachmentContentUrl,
} from '@/features/playground/api'
import {
  blobToDataUrl,
  loadPlaygroundAttachment,
} from '@/features/playground/lib/attachment-store'
import { getTaskArtifacts } from '@/features/usage-logs/api'

import {
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES,
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT,
  CANVAS_WORKFLOW_MESSAGES,
} from '../constants'
import type { CanvasWorkflowImageSource } from './canvas-workflow'

/**
 * A local read failure of a connected reference image. The message is the
 * translation key of the problem, so the run reports it like any other step
 * failure without inventing a server answer.
 */
export class CanvasWorkflowImageError extends Error {
  readonly messageKey: string

  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'CanvasWorkflowImageError'
    this.messageKey = messageKey
  }
}

function assertImageWithinLimit(byteSize: number): void {
  if (byteSize > CANVAS_WORKFLOW_IMAGE_INPUT_MAX_BYTES) {
    throw new CanvasWorkflowImageError(CANVAS_WORKFLOW_MESSAGES.IMAGE_TOO_LARGE)
  }
}

/**
 * Byte length of a base64 data URL payload, so an image primed from an upload
 * (which has no cached Blob) is measured without decoding it.
 */
function dataUrlByteSize(dataUrl: string): number {
  const separator = dataUrl.indexOf(',')
  if (separator < 0) return 0
  const payload = dataUrl.slice(separator + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/**
 * Reads one reference image as a data URL. Attachment bytes come from the
 * owner-scoped attachment content endpoint; a settled task's image comes from
 * its task artifact capability URL. Both are read through the gateway with the
 * caller's session, never from a provider URL stored on the canvas.
 */
export async function readCanvasWorkflowImage(
  source: CanvasWorkflowImageSource,
  signal?: AbortSignal
): Promise<string> {
  if (source.kind === 'attachment') {
    const entry = await loadPlaygroundAttachment(
      playgroundAttachmentContentUrl(source.sessionId, source.attachmentId),
      source.attachmentId
    ).catch(() => {
      // The bytes are read from the owner-scoped content endpoint, so a failed
      // read is a local reference-image problem, not a server answer.
      throw new CanvasWorkflowImageError(
        CANVAS_WORKFLOW_MESSAGES.IMAGE_UNAVAILABLE
      )
    })
    const dataUrl = entry.dataUrl
    if (!dataUrl) {
      throw new CanvasWorkflowImageError(
        CANVAS_WORKFLOW_MESSAGES.IMAGE_UNAVAILABLE
      )
    }
    assertImageWithinLimit(entry.blob?.size ?? dataUrlByteSize(dataUrl))
    return dataUrl
  }
  const projection = await getTaskArtifacts(source.taskId)
  const artifact = source.artifactKey
    ? projection.artifacts.find((item) => item.key === source.artifactKey)
    : projection.artifacts.find((item) => item.type === 'image')
  if (!artifact || artifact.type !== 'image') {
    throw new CanvasWorkflowImageError(
      CANVAS_WORKFLOW_MESSAGES.IMAGE_UNAVAILABLE
    )
  }
  const blob = await getPlaygroundAttachmentContent(
    artifact.content_url,
    signal
  )
  assertImageWithinLimit(blob.size)
  return blobToDataUrl(blob)
}

/**
 * Reads every reference image of one step in order. A failed read fails the
 * step instead of silently dropping the user's input. An over-limit set is
 * rejected before any bytes are read, so the reported reason is stable.
 */
export async function readCanvasWorkflowImages(
  sources: CanvasWorkflowImageSource[],
  signal?: AbortSignal
): Promise<string[]> {
  if (sources.length > CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT) {
    throw new CanvasWorkflowImageError(
      CANVAS_WORKFLOW_MESSAGES.IMAGE_INPUT_LIMIT
    )
  }
  const images: string[] = []
  for (const source of sources) {
    images.push(await readCanvasWorkflowImage(source, signal))
  }
  return images
}
