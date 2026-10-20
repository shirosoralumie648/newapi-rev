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
import { FolderOpen, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CanvasSendSeed } from '@/features/canvas/lib/canvas-send'
import type { PlaygroundAssetItem } from '@/features/playground/asset-api'
import {
  PLAYGROUND_ASSET_PAGE_SIZE,
  PLAYGROUND_ASSET_SEARCH_MAX_LENGTH,
} from '@/features/playground/constants'
import {
  useDeletePlaygroundAsset,
  usePlaygroundAssets,
} from '@/features/playground/hooks'
import { useDebounce } from '@/hooks/use-debounce'
import {
  getServerErrorMessage,
  getServerMessage,
} from '@/lib/server-error-message'

import { CanvasTaskList } from '../generation/canvas-task-list'
import { CanvasAssetCard } from './canvas-asset-card'
import { CanvasAssetPreviewDialog } from './canvas-asset-preview-dialog'

type CanvasLibraryKind = 'attachment' | 'artifact' | 'task'

interface CanvasAssetLibraryProps {
  active: boolean
  userId: number | null
  onSendAttachmentToChat?: (asset: PlaygroundAssetItem) => void
  onSendArtifactToChat?: (asset: PlaygroundAssetItem) => void
  onSendToCanvas: (asset: PlaygroundAssetItem) => void
  onSendSeedsToCanvas: (seeds: CanvasSendSeed[]) => void
  onOpenConversation: (sessionId: string) => void
}

/**
 * The unified asset library: Playground attachments and artifacts come from the
 * owner-scoped /api/playground/assets listing, and generation results reuse the
 * same task list as the generation panel, so the workspace has one place to
 * find, preview and reuse everything the account produced.
 */
export function CanvasAssetLibrary(props: CanvasAssetLibraryProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<CanvasLibraryKind>('attachment')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 250)
  const [page, setPage] = useState(1)
  const [previewAsset, setPreviewAsset] = useState<PlaygroundAssetItem | null>(
    null
  )
  const [assetToDelete, setAssetToDelete] =
    useState<PlaygroundAssetItem | null>(null)
  const deleteAsset = useDeletePlaygroundAsset(props.userId)

  const isTaskKind = kind === 'task'
  // Attachment listing is not fetched while the task kind is selected; the
  // disabled placeholder kind only shapes the unused query key.
  const assetsQuery = usePlaygroundAssets(
    props.userId,
    isTaskKind ? 'attachment' : kind,
    debouncedSearch,
    page,
    props.active && !isTaskKind
  )
  const items = assetsQuery.data?.items ?? []
  const total = assetsQuery.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PLAYGROUND_ASSET_PAGE_SIZE))

  const selectKind = (next: CanvasLibraryKind) => {
    setKind(next)
    setPage(1)
  }

  const changeSearch = (value: string) => {
    setSearch(value)
    setPage(1)
  }

  const confirmDelete = () => {
    const asset = assetToDelete
    if (!asset) return
    void deleteAsset.mutateAsync(asset).then(
      () => {
        setAssetToDelete(null)
        toast.success(t('Asset deleted'))
      },
      (error: unknown) => {
        toast.error(
          getServerErrorMessage(error, t('Unable to delete the asset.'))
        )
      }
    )
  }

  const kindOptions: { value: CanvasLibraryKind; label: string }[] = [
    { value: 'attachment', label: t('Attachments') },
    { value: 'artifact', label: t('Artifacts') },
    { value: 'task', label: t('Generation results') },
  ]

  let content: ReactNode
  if (isTaskKind) {
    content = (
      <CanvasTaskList
        active={props.active}
        onSendToCanvas={props.onSendSeedsToCanvas}
        search={debouncedSearch}
        showFilters
      />
    )
  } else if (assetsQuery.isError) {
    content = (
      <ErrorState
        className='min-h-40'
        title={t('Unable to load the Playground asset library.')}
        description={getServerMessage(assetsQuery.error)}
        onRetry={() => void assetsQuery.refetch()}
      />
    )
  } else if (assetsQuery.isPending) {
    content = <LoadingState className='min-h-40' />
  } else if (items.length === 0) {
    content = debouncedSearch ? (
      <EmptyState
        className='min-h-40'
        icon={FolderOpen}
        title={t('No results found')}
      />
    ) : (
      <EmptyState
        className='min-h-40'
        description={t('Attachments and artifacts you save appear here.')}
        icon={FolderOpen}
        title={t('No assets yet')}
      />
    )
  } else {
    content = (
      <ul className='grid list-none gap-2 p-0'>
        {items.map((asset) => (
          <CanvasAssetCard
            asset={asset}
            key={`${asset.kind}-${asset.id}`}
            onDelete={setAssetToDelete}
            onOpenConversation={(item) =>
              props.onOpenConversation(item.sessionId)
            }
            onPreview={setPreviewAsset}
            onSendToCanvas={props.onSendToCanvas}
            onSendToChat={
              props.onSendAttachmentToChat || props.onSendArtifactToChat
                ? (item) =>
                    item.kind === 'attachment'
                      ? props.onSendAttachmentToChat?.(item)
                      : props.onSendArtifactToChat?.(item)
                : undefined
            }
          />
        ))}
      </ul>
    )
  }

  return (
    <div
      className='flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3'
      data-tour='canvas-asset-library'
    >
      <div className='flex flex-col gap-2'>
        <div
          aria-label={t('Asset kind')}
          className='grid grid-cols-3 gap-1'
          role='group'
        >
          {kindOptions.map((option) => (
            <Button
              aria-pressed={kind === option.value}
              key={option.value}
              onClick={() => selectKind(option.value)}
              size='sm'
              type='button'
              variant={kind === option.value ? 'secondary' : 'ghost'}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className='relative'>
          <Search
            aria-hidden='true'
            className='text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2'
          />
          <Input
            aria-label={t('Search assets')}
            className='pl-8'
            maxLength={PLAYGROUND_ASSET_SEARCH_MAX_LENGTH}
            onChange={(event) => changeSearch(event.target.value)}
            placeholder={t('Search assets')}
            value={search}
          />
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto'>{content}</div>

      {!isTaskKind && total > PLAYGROUND_ASSET_PAGE_SIZE ? (
        <div className='flex items-center justify-between gap-2'>
          <Button
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            size='sm'
            type='button'
            variant='outline'
          >
            {t('Previous')}
          </Button>
          <span className='text-muted-foreground text-xs'>
            {t('Page {{current}} of {{total}}', {
              current: page,
              total: pageCount,
            })}
          </span>
          <Button
            disabled={page >= pageCount}
            onClick={() => setPage((current) => current + 1)}
            size='sm'
            type='button'
            variant='outline'
          >
            {t('Next')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        confirmText={t('Delete')}
        desc={t(
          'The asset will be removed from your Playground. Assets still in use cannot be deleted.'
        )}
        destructive
        handleConfirm={confirmDelete}
        isLoading={deleteAsset.isPending}
        onOpenChange={(open) => {
          if (!open) setAssetToDelete(null)
        }}
        open={assetToDelete !== null}
        title={t('Delete asset?')}
      />
      <CanvasAssetPreviewDialog
        asset={previewAsset}
        onOpenChange={(open) => {
          if (!open) setPreviewAsset(null)
        }}
        userId={props.userId}
      />
    </div>
  )
}
