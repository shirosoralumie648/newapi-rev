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

import {
  uploadCanvasAttachment,
  type PlaygroundServerAttachment,
} from '@/features/playground/api'
import {
  PLAYGROUND_ATTACHMENT_MAX_COUNT,
  PLAYGROUND_CANVAS_ATTACHMENT_ACCEPT,
  playgroundAttachmentMaxBytes,
} from '@/features/playground/constants'
import { primePlaygroundAttachment } from '@/features/playground/lib/attachment-store'
import {
  PLAYGROUND_ATTACHMENT_ERRORS,
  uploadPlaygroundAttachmentDirect,
} from '@/features/playground/lib/attachment-upload'

import { CANVAS_DROP_MESSAGES, CANVAS_DROP_NODE_OFFSET_X } from '../constants'
import type { CanvasAddedNode } from '../hooks/use-canvas-editor'

// The media types an attachment may carry; the server re-validates the same
// signature-checked whitelist of the conversation upload.
const CANVAS_DROP_MEDIA_TYPES = new Set(
  PLAYGROUND_CANVAS_ATTACHMENT_ACCEPT.split(',')
)

// Small images keep the one-request base64 path: the bytes are already primed
// for an instant preview. Everything larger, and every extended kind, goes
// through the reservation flow so the file never travels inside a JSON body.
const CANVAS_DROP_CLASSIC_MAX_BYTES = 1024 * 1024

/**
 * A rejected drop. The message is the translation key of the problem, so the
 * editor reports it like the other canvas messages without inventing a server
 * answer.
 */
export class CanvasDropError extends Error {
  readonly messageKey: string

  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'CanvasDropError'
    this.messageKey = messageKey
  }
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('loadend', () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const separator = result.indexOf(',')
      if (!result.startsWith('data:') || separator === -1) {
        reject(new CanvasDropError(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE))
        return
      }
      resolve(result.slice(separator + 1))
    })
    reader.addEventListener('error', () => {
      reject(new CanvasDropError(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE))
    })
    reader.readAsDataURL(file)
  })
}

/**
 * Checks a whole drop before anything is uploaded: a mixed drop is refused with
 * the first problem instead of silently keeping some files, and the server
 * re-validates every bound again.
 */
function validateCanvasDropFiles(files: File[]): void {
  if (files.length === 0) {
    throw new CanvasDropError(CANVAS_DROP_MESSAGES.UNSUPPORTED_TYPE)
  }
  if (files.length > PLAYGROUND_ATTACHMENT_MAX_COUNT) {
    throw new CanvasDropError(CANVAS_DROP_MESSAGES.TOO_MANY)
  }
  for (const file of files) {
    if (!CANVAS_DROP_MEDIA_TYPES.has(file.type)) {
      throw new CanvasDropError(CANVAS_DROP_MESSAGES.UNSUPPORTED_TYPE)
    }
    if (file.size <= 0) {
      throw new CanvasDropError(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE)
    }
    if (file.size > playgroundAttachmentMaxBytes(file.type)) {
      throw new CanvasDropError(PLAYGROUND_ATTACHMENT_ERRORS.TOO_LARGE)
    }
  }
}

/**
 * Uploads the files dropped on the board into the canvas' own attachment
 * partition and returns one attachment node per file, laid out to the right of
 * the drop point. Each node stores the partition, the attachment id and the
 * declared media type only, so the node renders the right player after a
 * reload. Small images are primed in the shared cache; larger files and the
 * extended kinds stream through the reservation flow.
 */
export async function canvasDropEntries(
  canvasId: string,
  dropPosition: { x: number; y: number },
  files: File[]
): Promise<CanvasAddedNode[]> {
  validateCanvasDropFiles(files)
  const entries: CanvasAddedNode[] = []
  for (const [index, file] of files.entries()) {
    let attachment: PlaygroundServerAttachment
    if (
      file.type.startsWith('image/') &&
      file.size <= CANVAS_DROP_CLASSIC_MAX_BYTES
    ) {
      const data = await fileBase64(file)
      const uploaded = await uploadCanvasAttachment(canvasId, {
        clientKey: nanoid(),
        mediaType: file.type,
        filename: file.name,
        data,
      })
      attachment = uploaded.attachment
      primePlaygroundAttachment(
        attachment.id,
        `data:${file.type};base64,${data}`
      )
    } else {
      attachment = await uploadPlaygroundAttachmentDirect({ canvasId }, file)
    }
    entries.push({
      kind: 'attachment',
      position: {
        x: dropPosition.x + index * CANVAS_DROP_NODE_OFFSET_X,
        y: dropPosition.y,
      },
      data: {
        label: attachment.filename,
        mediaType: attachment.mediaType,
        ref: { sessionId: attachment.sessionId, attachmentId: attachment.id },
      },
    })
  }
  return entries
}
