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
  ExternalLink,
  Eye,
  FileText,
  Frame,
  ImageIcon,
  MessageSquare,
  Music,
  Trash2,
  Video,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ArtifactAction,
  ArtifactActions,
} from '@/components/ai-elements/artifact'
import { Badge } from '@/components/ui/badge'
import { toIntlLocale } from '@/i18n/languages'
import { formatBytes, formatTimestampRelative } from '@/lib/format'

import type { PlaygroundAssetItem } from '../../asset-api'
import { playgroundAttachmentKind } from '../../constants'
import { useAttachmentPreviewUrl } from '../../hooks'

interface PlaygroundAssetCardProps {
  asset: PlaygroundAssetItem
  onPreview: (asset: PlaygroundAssetItem) => void
  onSendToChat: (asset: PlaygroundAssetItem) => void
  onSendToCanvas: (asset: PlaygroundAssetItem) => void
  onOpenConversation: (asset: PlaygroundAssetItem) => void
  onDelete: (asset: PlaygroundAssetItem) => void
}

/**
 * One library entry with its metadata and actions. The thumbnail for an
 * attachment loads through the owner-scoped content endpoint; every action
 * re-verifies ownership on the server, so the card only carries ids.
 */
export function PlaygroundAssetCard(props: PlaygroundAssetCardProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const asset = props.asset
  const isAttachment = asset.kind === 'attachment'
  const previewUrl = useAttachmentPreviewUrl(
    isAttachment ? asset.sessionId : undefined,
    isAttachment ? asset.id : undefined
  )

  const updated = formatTimestampRelative(
    asset.updatedAt,
    'milliseconds',
    locale
  )
  const meta = isAttachment
    ? [
        typeof asset.byteSize === 'number'
          ? formatBytes(asset.byteSize, locale)
          : null,
        updated,
      ]
    : [asset.language, updated]
  const title = asset.title || (isAttachment ? t('Attachment') : t('Artifacts'))

  let thumbnail = <FileText aria-hidden='true' className='size-4' />
  if (isAttachment) {
    const attachmentKind = playgroundAttachmentKind(asset.mediaType)
    if (attachmentKind === 'video') {
      thumbnail = <Video aria-hidden='true' className='size-4' />
    } else if (attachmentKind === 'audio') {
      thumbnail = <Music aria-hidden='true' className='size-4' />
    } else if (attachmentKind === 'image') {
      thumbnail = previewUrl ? (
        <img alt='' className='size-10 object-cover' src={previewUrl} />
      ) : (
        <ImageIcon aria-hidden='true' className='size-4' />
      )
    }
  }

  return (
    <li className='rounded-lg border p-2.5'>
      <div className='flex min-w-0 items-start gap-2'>
        <div className='bg-muted/40 text-muted-foreground flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md'>
          {thumbnail}
        </div>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1.5'>
            <p className='truncate text-sm font-medium'>{title}</p>
            {asset.inUse ? (
              <Badge variant='secondary'>{t('In use')}</Badge>
            ) : null}
          </div>
          <p className='text-muted-foreground truncate text-xs'>
            {meta.filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>
      <ArtifactActions className='mt-2'>
        <ArtifactAction
          icon={Eye}
          label={t('Preview')}
          onClick={() => props.onPreview(asset)}
          tooltip={t('Preview')}
        />
        <ArtifactAction
          icon={MessageSquare}
          label={t('Send to chat')}
          onClick={() => props.onSendToChat(asset)}
          tooltip={t('Send to chat')}
        />
        <ArtifactAction
          icon={Frame}
          label={t('Send to canvas')}
          onClick={() => props.onSendToCanvas(asset)}
          tooltip={t('Send to canvas')}
        />
        <ArtifactAction
          icon={ExternalLink}
          label={t('Open conversation')}
          onClick={() => props.onOpenConversation(asset)}
          tooltip={t('Open conversation')}
        />
        <ArtifactAction
          disabled={asset.inUse}
          icon={Trash2}
          label={t('Delete')}
          onClick={() => props.onDelete(asset)}
          tooltip={asset.inUse ? t('In use') : t('Delete')}
        />
      </ArtifactActions>
    </li>
  )
}
