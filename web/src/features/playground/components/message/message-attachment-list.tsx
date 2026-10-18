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
import { AudioLines, FileText, ImageIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isPlaygroundDocumentMediaType } from '../../constants'
import {
  getPlaygroundAttachmentDataUrl,
  getPlaygroundAttachmentObjectUrl,
  loadPlaygroundAttachment,
} from '../../lib'
import type { MessageAttachment } from '../../types'

/**
 * Display URL of one stored attachment. Freshly uploaded bytes are already
 * cached; anything else loads through the owner-scoped content endpoint once.
 * A document renders from its icon and never downloads its bytes.
 */
export function useMessageAttachmentPreviewUrl(
  attachment: MessageAttachment
): string | undefined {
  const wantsBytes =
    attachment.mediaType.startsWith('image/') ||
    attachment.mediaType.startsWith('audio/')
  const [url, setUrl] = useState<string | undefined>(() =>
    wantsBytes
      ? (getPlaygroundAttachmentObjectUrl(attachment.id) ??
        getPlaygroundAttachmentDataUrl(attachment.id))
      : undefined
  )

  useEffect(() => {
    if (!wantsBytes || url || !attachment.url) return
    let active = true
    void loadPlaygroundAttachment(attachment.url, attachment.id)
      .then((entry) => {
        if (active) {
          setUrl(entry.objectUrl ?? entry.dataUrl)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [attachment.id, attachment.url, url, wantsBytes])

  return url
}

function MessageAttachmentCard({
  attachment,
}: {
  attachment: MessageAttachment
}) {
  const { t } = useTranslation()
  const previewUrl = useMessageAttachmentPreviewUrl(attachment)
  const isImage = attachment.mediaType.startsWith('image/')
  const isAudio = attachment.mediaType.startsWith('audio/')
  const isDocument = isPlaygroundDocumentMediaType(attachment.mediaType)
  const label = attachment.filename || t('Attachment')

  return (
    <figure
      className='border-border/70 bg-muted/20 overflow-hidden rounded-lg border'
      title={label}
    >
      {isImage &&
        (previewUrl ? (
          <img
            alt={label}
            className='max-h-48 w-40 object-cover'
            src={previewUrl}
          />
        ) : (
          <div className='text-muted-foreground flex h-24 w-40 items-center justify-center'>
            <ImageIcon className='size-5' />
          </div>
        ))}
      {isAudio &&
        (previewUrl ? (
          <div className='w-64 p-2'>
            <audio
              aria-label={label}
              className='h-8 w-full'
              controls
              src={previewUrl}
            />
          </div>
        ) : (
          <div className='text-muted-foreground flex h-24 w-40 items-center justify-center'>
            <AudioLines className='size-5' />
          </div>
        ))}
      {isDocument && (
        <div className='text-muted-foreground flex h-24 w-40 items-center justify-center'>
          <FileText className='size-5' aria-hidden='true' />
        </div>
      )}
      <figcaption className='text-muted-foreground w-40 truncate px-2 py-1 text-xs'>
        {label}
      </figcaption>
    </figure>
  )
}

export function MessageAttachmentList({
  attachments,
}: {
  attachments: MessageAttachment[]
}) {
  if (attachments.length === 0) return null
  return (
    <div className='mb-2 flex flex-wrap gap-2'>
      {attachments.map((attachment) => (
        <MessageAttachmentCard key={attachment.id} attachment={attachment} />
      ))}
    </div>
  )
}
