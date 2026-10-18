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
import type { FileUIPart } from 'ai'
import { nanoid } from 'nanoid'

import {
  playgroundAttachmentContentUrl,
  uploadPlaygroundAttachment,
} from '../api'
import {
  PLAYGROUND_ATTACHMENT_MAX_BYTES,
  PLAYGROUND_ATTACHMENT_MAX_COUNT,
} from '../constants'
import type { MessageAttachment } from '../types'
import { blobToDataUrl, primePlaygroundAttachment } from './attachment-store'

/**
 * Stable translation keys for upload failures the input shows directly. The
 * strings double as English source text and as i18n keys.
 */
export const PLAYGROUND_ATTACHMENT_ERRORS = {
  TOO_MANY: 'Too many attachments. Remove some before sending.',
  TOO_LARGE: 'Attachment is too large.',
  UNREADABLE: 'Attachment data could not be read.',
  UPLOAD_FAILED: 'Attachment upload failed. Your message was not sent.',
} as const

function attachmentBase64(file: FileUIPart): string {
  const separator = file.url.indexOf(',')
  if (!file.url.startsWith('data:') || separator === -1) {
    throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE)
  }
  return file.url.slice(separator + 1)
}

/**
 * Uploads the input files to the conversation and returns the attachment
 * references stored on the outgoing message.
 */
export async function uploadPlaygroundAttachments(
  sessionId: string,
  files: (FileUIPart & { id?: string })[]
): Promise<MessageAttachment[]> {
  if (files.length > PLAYGROUND_ATTACHMENT_MAX_COUNT) {
    throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.TOO_MANY)
  }
  const attachments: MessageAttachment[] = []
  for (const file of files) {
    const data = attachmentBase64(file)
    // Base64 length is the decoded size rounded up to a 4-character group.
    if (Math.ceil((data.length * 3) / 4) > PLAYGROUND_ATTACHMENT_MAX_BYTES) {
      throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.TOO_LARGE)
    }
    const { attachment } = await uploadPlaygroundAttachment(sessionId, {
      clientKey: file.id ?? nanoid(),
      mediaType: file.mediaType || 'application/octet-stream',
      filename: file.filename,
      data,
    })
    primePlaygroundAttachment(attachment.id, file.url)
    attachments.push({
      id: attachment.id,
      url: playgroundAttachmentContentUrl(attachment.sessionId, attachment.id),
      mediaType: attachment.mediaType,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
    })
  }
  return attachments
}

// Filenames of cached speech by media type; the stored name is display-only,
// but the extension keeps the attachment identifiable in the asset library.
const SPEECH_FILENAMES: Record<string, string> = {
  'audio/mpeg': 'speech.mp3',
  'audio/wav': 'speech.wav',
  'audio/ogg': 'speech.ogg',
  'audio/webm': 'speech.webm',
}

/**
 * Caches generated speech bytes as a conversation attachment and returns the
 * reference a message stores. Uploading follows the attachment path, so the
 * audio is owned by the account and survives browsing; the bytes are primed
 * into the local cache so the player renders without downloading them again.
 */
export async function uploadPlaygroundSpeechAttachment(
  sessionId: string,
  blob: Blob
): Promise<MessageAttachment> {
  if (blob.size === 0) {
    throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE)
  }
  if (blob.size > PLAYGROUND_ATTACHMENT_MAX_BYTES) {
    throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.TOO_LARGE)
  }
  const mediaType = blob.type || 'audio/mpeg'
  const filename = SPEECH_FILENAMES[mediaType] ?? 'speech.mp3'
  const dataUrl = await blobToDataUrl(blob)
  const separator = dataUrl.indexOf(',')
  if (separator === -1) {
    throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE)
  }
  const { attachment } = await uploadPlaygroundAttachment(sessionId, {
    clientKey: nanoid(),
    mediaType,
    filename,
    data: dataUrl.slice(separator + 1),
  })
  primePlaygroundAttachment(attachment.id, dataUrl)
  return {
    id: attachment.id,
    url: playgroundAttachmentContentUrl(attachment.sessionId, attachment.id),
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    byteSize: attachment.byteSize,
  }
}
