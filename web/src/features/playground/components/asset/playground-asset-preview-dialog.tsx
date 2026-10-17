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
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeBlock } from '@/components/ai-elements/code-block'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Markdown } from '@/components/ui/markdown'
import { getServerMessage } from '@/lib/server-error-message'

import { getPlaygroundArtifact } from '../../artifact-api'
import type { PlaygroundAssetItem } from '../../asset-api'
import { useAttachmentPreviewUrl } from '../../hooks'
import { playgroundQueryKeys } from '../../lib/query-keys'

interface PlaygroundAssetPreviewDialogProps {
  asset: PlaygroundAssetItem | null
  userId: number | null
  onOpenChange: (open: boolean) => void
}

/**
 * Read-only preview of one library entry. An attachment is shown through the
 * owner-scoped content endpoint; an artifact loads its current version through
 * the ordinary artifact endpoint, so both keep the server as the source of
 * truth and never embed stored bytes in the list itself.
 */
export function PlaygroundAssetPreviewDialog(
  props: PlaygroundAssetPreviewDialogProps
) {
  const { t } = useTranslation()
  const asset = props.asset
  const isAttachment = asset?.kind === 'attachment'
  const previewUrl = useAttachmentPreviewUrl(
    isAttachment ? asset.sessionId : undefined,
    isAttachment ? asset.id : undefined
  )
  const artifactSessionId = asset?.kind === 'artifact' ? asset.sessionId : null
  const artifactId = asset?.kind === 'artifact' ? asset.id : null
  const artifactQuery = useQuery({
    queryKey: playgroundQueryKeys.artifactDetail(
      props.userId,
      artifactSessionId,
      artifactId
    ),
    queryFn: () => {
      if (!artifactSessionId || !artifactId) {
        return Promise.reject(new Error('Artifact preview unavailable.'))
      }
      return getPlaygroundArtifact(artifactSessionId, artifactId)
    },
    enabled: artifactSessionId !== null && artifactId !== null,
    meta: { errorToast: false },
  })

  const artifact = artifactQuery.data?.artifact
  const version = artifactQuery.data?.version
  let body: ReactNode = null
  if (isAttachment) {
    body = previewUrl ? (
      <img
        alt={asset.title || t('Attachment')}
        className='max-h-[60vh] w-full rounded-md object-contain'
        src={previewUrl}
      />
    ) : (
      <p className='text-muted-foreground p-6 text-center text-sm'>
        {t('Preview unavailable')}
      </p>
    )
  } else if (artifactSessionId !== null) {
    if (artifactQuery.isPending) {
      body = <LoadingState className='min-h-40' />
    } else if (artifactQuery.isError) {
      body = (
        <ErrorState
          className='min-h-0 p-2'
          title={t('Unable to load the Playground asset library.')}
          description={getServerMessage(artifactQuery.error)}
          onRetry={() => void artifactQuery.refetch()}
        />
      )
    } else if (version) {
      body =
        artifact?.kind === 'code' ? (
          <CodeBlock
            code={version.content}
            language={version.language || 'plaintext'}
            showToolbar
            title={version.title}
          />
        ) : (
          <Markdown>{version.content}</Markdown>
        )
    }
  }

  return (
    <Dialog
      contentClassName='sm:max-w-2xl'
      contentHeight='auto'
      description={asset?.title}
      onOpenChange={props.onOpenChange}
      open={asset !== null}
      title={artifact?.title ?? asset?.title ?? t('Preview')}
    >
      {body}
    </Dialog>
  )
}
