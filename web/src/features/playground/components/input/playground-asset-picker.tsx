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
import { Loader2, PaperclipIcon, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  PromptInputButton,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useDebounce } from '@/hooks/use-debounce'
import { useIsMobile } from '@/hooks/use-mobile'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { playgroundAttachmentContentUrl } from '../../api'
import { getPlaygroundArtifact } from '../../artifact-api'
import type { PlaygroundAssetItem } from '../../asset-api'
import {
  PLAYGROUND_ASSET_PAGE_SIZE,
  PLAYGROUND_ASSET_SEARCH_MAX_LENGTH,
} from '../../constants'
import { usePlaygroundAssets } from '../../hooks'
import { loadPlaygroundAttachment } from '../../lib/attachment-store'

interface PlaygroundAssetPickerProps {
  disabled?: boolean
  /** Appends an artifact body to the composer draft. */
  onInsertText: (content: string) => void
}

type PickerKind = 'attachment' | 'artifact'
type PickerTab = 'upload' | 'assets'
type LoadStatus = 'idle' | 'loading' | 'error' | 'ready'

/**
 * The composer attachment layer. Upload stays a direct file picker, while the
 * "My assets" tab keeps a lightweight path for reusing an attachment or an
 * artifact body in the conversation without opening the canvas library.
 */
export function PlaygroundAssetPicker(props: PlaygroundAssetPickerProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const attachments = usePromptInputAttachments()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PickerTab>('upload')
  const [kind, setKind] = useState<PickerKind>('attachment')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 250)
  const [page, setPage] = useState(1)
  const [pending, setPending] = useState<string | null>(null)

  const assetsQuery = usePlaygroundAssets(
    userId,
    kind,
    debouncedSearch,
    page,
    open
  )
  const items = assetsQuery.data?.items ?? []
  const total = assetsQuery.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PLAYGROUND_ASSET_PAGE_SIZE))

  let status: LoadStatus = 'idle'
  if (open && assetsQuery.isError) status = 'error'
  else if (open && assetsQuery.isLoading) status = 'loading'
  else if (open) status = 'ready'

  const close = () => setOpen(false)

  const addAttachment = async (asset: PlaygroundAssetItem) => {
    if (pending) return
    setPending(asset.id)
    try {
      const entry = await loadPlaygroundAttachment(
        playgroundAttachmentContentUrl(asset.sessionId, asset.id),
        asset.id
      )
      const blob = entry.blob
      if (!blob) return
      const file = new File([blob], asset.title || asset.id, {
        type: asset.mediaType || blob.type || 'application/octet-stream',
      })
      attachments.add([file])
      toast.success(t('Asset added to the message'))
      close()
    } catch (error) {
      handleServerError(error, t('Unable to add the asset to your message.'))
    } finally {
      setPending(null)
    }
  }

  const addArtifact = async (asset: PlaygroundAssetItem) => {
    if (pending) return
    setPending(asset.id)
    try {
      const result = await getPlaygroundArtifact(asset.sessionId, asset.id)
      props.onInsertText(result.version.content)
      toast.success(t('Asset added to the message'))
      close()
    } catch (error) {
      handleServerError(error, t('Unable to add the asset to your message.'))
    } finally {
      setPending(null)
    }
  }

  const content = (
    <Tabs
      className='min-h-0'
      onValueChange={(value) => setTab(value as PickerTab)}
      value={tab}
    >
      <TabsList className='grid w-full grid-cols-2'>
        <TabsTrigger value='upload'>{t('Upload files')}</TabsTrigger>
        <TabsTrigger value='assets'>{t('My assets')}</TabsTrigger>
      </TabsList>
      <TabsContent className='min-h-0' value='upload'>
        <div className='grid gap-2 p-1'>
          <p className='text-muted-foreground text-xs'>
            {t('Add images or documents to this message.')}
          </p>
          <Button
            disabled={props.disabled}
            onClick={() => {
              attachments.openFileDialog()
              close()
            }}
            size='sm'
            type='button'
            variant='outline'
          >
            <PaperclipIcon aria-hidden='true' />
            {t('Choose files')}
          </Button>
        </div>
      </TabsContent>
      <TabsContent className='min-h-0' value='assets'>
        <div className='grid gap-2 p-1'>
          <div className='flex items-center gap-1'>
            <Button
              aria-pressed={kind === 'attachment'}
              onClick={() => {
                setKind('attachment')
                setPage(1)
              }}
              size='sm'
              type='button'
              variant={kind === 'attachment' ? 'secondary' : 'ghost'}
            >
              {t('Attachments')}
            </Button>
            <Button
              aria-pressed={kind === 'artifact'}
              onClick={() => {
                setKind('artifact')
                setPage(1)
              }}
              size='sm'
              type='button'
              variant={kind === 'artifact' ? 'secondary' : 'ghost'}
            >
              {t('Artifacts')}
            </Button>
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
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
              placeholder={t('Search assets')}
              value={search}
            />
          </div>

          <div className='max-h-64 min-h-24 overflow-y-auto'>
            {status === 'loading' && <LoadingState className='min-h-24' />}
            {status === 'error' && (
              <ErrorState
                className='min-h-24'
                description={getServerMessage(assetsQuery.error)}
                onRetry={() => void assetsQuery.refetch()}
                title={t('Unable to load the Playground asset library.')}
              />
            )}
            {status === 'ready' && items.length === 0 && (
              <EmptyState className='min-h-24' title={t('No assets yet')} />
            )}
            {status === 'ready' && items.length > 0 && (
              <ul className='grid list-none gap-1 p-0'>
                {items.map((asset) => (
                  <li
                    className='flex items-center justify-between gap-2 rounded-md border p-2'
                    key={`${asset.kind}-${asset.id}`}
                  >
                    <span className='min-w-0 flex-1 truncate text-xs'>
                      {asset.title || asset.id}
                    </span>
                    <Button
                      disabled={props.disabled || pending !== null}
                      onClick={() =>
                        void (asset.kind === 'attachment'
                          ? addAttachment(asset)
                          : addArtifact(asset))
                      }
                      size='sm'
                      type='button'
                      variant='outline'
                    >
                      {pending === asset.id ? (
                        <Loader2 aria-hidden='true' className='animate-spin' />
                      ) : null}
                      {t('Add to message')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {status === 'ready' && total > PLAYGROUND_ASSET_PAGE_SIZE ? (
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
        </div>
      </TabsContent>
    </Tabs>
  )

  const trigger = (
    <PromptInputButton
      aria-label={t('Attach')}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <PaperclipIcon size={16} />
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Attach')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('My assets')}</SheetTitle>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Attach')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='w-[24rem] max-w-[calc(100vw-2rem)] gap-3 p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
