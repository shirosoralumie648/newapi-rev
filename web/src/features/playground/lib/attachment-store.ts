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
import { getPlaygroundAttachmentContent } from '../api'
import type { Message } from '../types'

type AttachmentCacheEntry = {
  blob?: Blob
  dataUrl?: string
  objectUrl?: string
}

const cache = new Map<string, AttachmentCacheEntry>()
const pendingLoads = new Map<string, Promise<AttachmentCacheEntry>>()

function cacheEntry(id: string): AttachmentCacheEntry {
  let entry = cache.get(id)
  if (!entry) {
    entry = {}
    cache.set(id, entry)
  }
  return entry
}

/**
 * Remembers the bytes of a freshly uploaded attachment so the message renders
 * and the next model request can reuse them without another download.
 */
export function primePlaygroundAttachment(id: string, dataUrl: string): void {
  cacheEntry(id).dataUrl = dataUrl
}

export function getPlaygroundAttachmentDataUrl(id: string): string | undefined {
  return cache.get(id)?.dataUrl
}

export function getPlaygroundAttachmentObjectUrl(
  id: string
): string | undefined {
  return cache.get(id)?.objectUrl
}

/**
 * Encodes blob bytes as a data URL, the request form the model payload and the
 * canvas reference-image input both use.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('loadend', () => resolve(reader.result as string), {
      once: true,
    })
    reader.addEventListener(
      'error',
      () => reject(reader.error ?? new Error('Failed to read attachment')),
      { once: true }
    )
    reader.readAsDataURL(blob)
  })
}

/**
 * Loads attachment bytes through the authenticated content endpoint once and
 * caches the display and request forms. Concurrent callers share one request.
 */
export function loadPlaygroundAttachment(
  contentUrl: string,
  id: string
): Promise<AttachmentCacheEntry> {
  const entry = cache.get(id)
  if (entry?.objectUrl && entry.dataUrl) {
    return Promise.resolve(entry)
  }
  const existing = pendingLoads.get(id)
  if (existing) return existing
  const request = (async () => {
    try {
      const blob = await getPlaygroundAttachmentContent(contentUrl)
      const current = cacheEntry(id)
      current.blob ??= blob
      current.objectUrl ??= URL.createObjectURL(blob)
      current.dataUrl ??= await blobToDataUrl(blob)
      return current
    } finally {
      pendingLoads.delete(id)
    }
  })()
  pendingLoads.set(id, request)
  return request
}

/**
 * Ensures every attachment in the outgoing message history has cached bytes.
 * A reference whose bytes are already gone is skipped: the conversation still
 * sends, and the stored message keeps the reference for display.
 */
export async function ensurePlaygroundMessageAttachments(
  messages: Message[]
): Promise<void> {
  const missing = new Map<string, string>()
  for (const message of messages) {
    // Only the active version is sent and rendered, so its attachments are the
    // only bytes the next request needs; hidden branches load lazily on switch.
    const activeVersion =
      message.versions[message.activeVersionIndex ?? 0] ?? message.versions[0]
    for (const attachment of activeVersion?.attachments ?? []) {
      if (!getPlaygroundAttachmentDataUrl(attachment.id) && attachment.url) {
        missing.set(attachment.id, attachment.url)
      }
    }
  }
  if (missing.size === 0) return
  await Promise.all(
    [...missing].map(([id, url]) =>
      loadPlaygroundAttachment(url, id).catch(() => undefined)
    )
  )
}

export function clearPlaygroundAttachmentCache(): void {
  for (const entry of cache.values()) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl)
  }
  cache.clear()
  pendingLoads.clear()
}
