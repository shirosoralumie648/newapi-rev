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
import { useEffect, useState } from 'react'

import { playgroundAttachmentContentUrl } from '../api'
import {
  getPlaygroundAttachmentObjectUrl,
  loadPlaygroundAttachment,
} from '../lib/attachment-store'

/**
 * Resolves an attachment's preview through the owner-scoped content endpoint.
 * Callers pass IDs only, so a missing session or attachment simply renders the
 * placeholder and never fetches an unowned URL. Bytes are cached per id, so
 * the canvas node and the asset library share one download.
 */
export function useAttachmentPreviewUrl(
  sessionId?: string,
  attachmentId?: string
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() =>
    attachmentId ? getPlaygroundAttachmentObjectUrl(attachmentId) : undefined
  )

  useEffect(() => {
    if (url || !sessionId || !attachmentId) return
    let active = true
    void loadPlaygroundAttachment(
      playgroundAttachmentContentUrl(sessionId, attachmentId),
      attachmentId
    )
      .then((entry) => {
        if (active) setUrl(entry.objectUrl ?? entry.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [attachmentId, sessionId, url])

  return url
}
