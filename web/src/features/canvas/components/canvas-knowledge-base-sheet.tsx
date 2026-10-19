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
import { useQueryClient } from '@tanstack/react-query'
import { Database, Loader2, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Progress } from '@/components/ui/progress'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  DEFAULT_GROUP,
  PLAYGROUND_DOCUMENT_ACCEPT,
  PLAYGROUND_DOCUMENT_MAX_BYTES,
} from '@/features/playground/constants'
import {
  useKnowledgeBases,
  useKnowledgeDocuments,
  useKnowledgeGroups,
} from '@/features/playground/hooks'
import {
  createKnowledgeBase,
  createKnowledgeClientKey,
  createKnowledgeDocument,
  deleteKnowledgeBase,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  indexKnowledgeDocument,
  reindexKnowledgeDocument,
  type KnowledgeBase,
  type KnowledgeDocument,
} from '@/features/playground/knowledge-api'
import { getGroupFallback } from '@/features/playground/lib'
import { playgroundQueryKeys } from '@/features/playground/lib/query-keys'
import type { GroupOption } from '@/features/playground/types'
import { toIntlLocale } from '@/i18n/languages'
import { formatBytes, formatNumber } from '@/lib/format'
import {
  getServerMessage,
  translateServerText,
} from '@/lib/server-error-message'

interface CanvasKnowledgeBaseSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: number | null
}

type PendingDelete =
  | { kind: 'base'; id: string; name: string }
  | { kind: 'document'; id: string; name: string }

const STATUS_LABELS: Record<KnowledgeDocument['status'], string> = {
  pending: 'Pending',
  ready: 'Indexed',
  failed: 'Indexing failed',
}

function KnowledgeDocumentRow(props: {
  busy: boolean
  document: KnowledgeDocument
  embeddingModel: string
  locale: string
  onDelete: (document: KnowledgeDocument) => void
  onRetry: (document: KnowledgeDocument) => void
}) {
  const { t } = useTranslation()
  const statusVariant =
    props.document.status === 'ready'
      ? 'secondary'
      : props.document.status === 'failed'
        ? 'destructive'
        : 'warning'
  const needsRebuild =
    props.document.status === 'ready' &&
    props.document.embeddingModel !== '' &&
    props.document.embeddingModel !== props.embeddingModel

  return (
    <div className='flex flex-col gap-2 rounded-lg border p-3'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <p className='truncate text-sm font-medium'>
            {props.document.filename}
          </p>
          <p className='text-muted-foreground text-xs tabular-nums'>
            {t('{{chunks}} chunks · {{bytes}}', {
              chunks: formatNumber(props.document.chunkCount, props.locale),
              bytes: formatBytes(props.document.byteSize, props.locale),
            })}
          </p>
        </div>
        <div className='flex flex-wrap items-center justify-end gap-1'>
          {needsRebuild && (
            <Badge variant='outline'>{t('Needs rebuild')}</Badge>
          )}
          <Badge variant={statusVariant}>
            {t(STATUS_LABELS[props.document.status])}
          </Badge>
        </div>
      </div>
      {props.document.errorMessage !== '' && (
        <p className='text-destructive text-xs' role='alert'>
          {translateServerText(t, props.document.errorMessage)}
        </p>
      )}
      <div className='flex items-center justify-end gap-1'>
        <Button
          aria-label={t('Rebuild the index of {{name}}', {
            name: props.document.filename,
          })}
          disabled={props.busy}
          onClick={() => props.onRetry(props.document)}
          size='sm'
          type='button'
          variant='outline'
        >
          {props.busy ? (
            <Loader2 aria-hidden='true' className='animate-spin' />
          ) : (
            <RotateCcw aria-hidden='true' />
          )}
          {t('Rebuild index')}
        </Button>
        <Button
          aria-label={t('Delete {{name}}', { name: props.document.filename })}
          disabled={props.busy}
          onClick={() => props.onDelete(props.document)}
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <Trash2 aria-hidden='true' />
        </Button>
      </div>
    </div>
  )
}

/**
 * Canvas-domain knowledge manager (LB-14 ownership): create bases, upload and
 * index documents, rebuild an index and inspect storage usage. Conversation
 * binding lives in LB-08 and is intentionally absent here.
 */
export function CanvasKnowledgeBaseSheet(props: CanvasKnowledgeBaseSheetProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const queryClient = useQueryClient()
  const basesQuery = useKnowledgeBases(props.userId)
  const groupsQuery = useKnowledgeGroups(props.userId)
  const bases = basesQuery.data ?? []
  const groups: GroupOption[] = groupsQuery.data ?? []
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null)
  const selectedBase = bases.find((base) => base.id === selectedBaseId) ?? null
  const documentsQuery = useKnowledgeDocuments(
    props.userId,
    selectedBase?.id ?? null
  )
  const [name, setName] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('text-embedding-3-small')
  const [group, setGroup] = useState<string>(DEFAULT_GROUP)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{
    documentId: string
    completed: number
    total: number
  } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (
      selectedBaseId !== null &&
      bases.some((base) => base.id === selectedBaseId)
    )
      return
    setSelectedBaseId(bases[0]?.id ?? null)
  }, [bases, selectedBaseId])

  useEffect(() => {
    const fallback = getGroupFallback(groups, group)
    if (fallback !== null) setGroup(fallback)
  }, [groups, group])

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: playgroundQueryKeys.knowledgeBases(props.userId),
    })
    if (selectedBase !== null) {
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.knowledgeDocuments(
          props.userId,
          selectedBase.id
        ),
      })
    }
    void queryClient.invalidateQueries({
      queryKey: playgroundQueryKeys.usage(props.userId),
    })
  }

  const reportError = (error: unknown, fallback: string) => {
    toast.error(t(getServerMessage(error) ?? fallback))
  }

  const handleCreateBase = async () => {
    const trimmedName = name.trim()
    const trimmedModel = embeddingModel.trim()
    if (trimmedName === '' || trimmedModel === '') {
      toast.error(t('Enter a name and an embedding model.'))
      return
    }
    setBusy('create-base')
    try {
      const created = await createKnowledgeBase({
        name: trimmedName,
        embeddingModel: trimmedModel,
        clientKey: createKnowledgeClientKey('pgkb'),
      })
      setName('')
      setSelectedBaseId(created.id)
      refresh()
      toast.success(t('Knowledge base created.'))
    } catch (error) {
      reportError(error, 'The knowledge base could not be created.')
    } finally {
      setBusy(null)
    }
  }

  const embedDocument = async (
    base: KnowledgeBase,
    document: KnowledgeDocument,
    reset: boolean
  ): Promise<void> => {
    setBusy(`index:${document.id}`)
    setProgress({ documentId: document.id, completed: 0, total: 0 })
    try {
      const target = reset
        ? await reindexKnowledgeDocument(base.id, document.id)
        : document
      const text =
        target.text ??
        (await getKnowledgeDocument(base.id, document.id)).text ??
        ''
      await indexKnowledgeDocument({
        knowledgeBaseId: base.id,
        documentId: document.id,
        embeddingModel: base.embeddingModel,
        text,
        group,
        onProgress: (completed, total) =>
          setProgress({ documentId: document.id, completed, total }),
      })
      toast.success(t('Document indexed.'))
    } catch (error) {
      reportError(
        error,
        'The document was saved, but its index could not be rebuilt.'
      )
    } finally {
      setBusy(null)
      setProgress(null)
      refresh()
    }
  }

  const handleUpload = async (file: File) => {
    if (selectedBase === null) return
    if (file.size > PLAYGROUND_DOCUMENT_MAX_BYTES) {
      toast.error(t('The document is too large.'))
      return
    }
    setBusy('upload')
    let document: KnowledgeDocument
    try {
      document = await createKnowledgeDocument(selectedBase.id, {
        filename: file.name,
        mediaType: file.type || 'application/octet-stream',
        data: await file.arrayBuffer(),
        clientKey: createKnowledgeClientKey('pgkd'),
      })
      refresh()
      toast.success(t('Document uploaded.'))
    } catch (error) {
      reportError(error, 'The document could not be uploaded.')
      return
    } finally {
      setBusy(null)
    }
    await embedDocument(selectedBase, document, false)
  }

  const handleRetry = async (document: KnowledgeDocument) => {
    if (selectedBase === null) return
    await embedDocument(selectedBase, document, true)
  }

  const handleConfirmDelete = async () => {
    if (pendingDelete === null) return
    setBusy(`delete:${pendingDelete.id}`)
    try {
      if (pendingDelete.kind === 'base') {
        await deleteKnowledgeBase(pendingDelete.id)
        if (selectedBaseId === pendingDelete.id) setSelectedBaseId(null)
        toast.success(t('Knowledge base deleted.'))
      } else if (selectedBase !== null) {
        await deleteKnowledgeDocument(selectedBase.id, pendingDelete.id)
        toast.success(t('Document deleted.'))
      }
      setPendingDelete(null)
      refresh()
    } catch (error) {
      reportError(error, 'The item could not be deleted.')
    } finally {
      setBusy(null)
    }
  }

  const documents = documentsQuery.data ?? []
  const indexingProgress =
    progress !== null && progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0

  return (
    <>
      <Sheet onOpenChange={props.onOpenChange} open={props.open}>
        <SheetContent className='w-full gap-0 p-0 sm:max-w-2xl' side='right'>
          <SheetHeader className='border-b pr-12'>
            <SheetTitle>{t('Knowledge bases')}</SheetTitle>
            <SheetDescription>
              {t(
                'Upload documents, compute their embeddings through the relay and rebuild the index when it changes.'
              )}
            </SheetDescription>
          </SheetHeader>

          <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4'>
            <div className='flex flex-col gap-2'>
              <Label htmlFor='knowledge-embedding-group'>
                {t('Embedding group')}
              </Label>
              <NativeSelect
                aria-label={t('Embedding group')}
                className='w-full'
                id='knowledge-embedding-group'
                onChange={(event) => setGroup(event.target.value)}
                value={group}
              >
                {groups.map((option) => (
                  <NativeSelectOption key={option.value} value={option.value}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className='flex flex-col gap-2 rounded-lg border p-3'>
              <p className='text-sm font-medium'>{t('New knowledge base')}</p>
              <div className='grid gap-2 sm:grid-cols-2'>
                <div className='flex flex-col gap-1.5'>
                  <Label htmlFor='knowledge-base-name'>
                    {t('Knowledge base name')}
                  </Label>
                  <Input
                    id='knowledge-base-name'
                    maxLength={100}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('Product handbook')}
                    value={name}
                  />
                </div>
                <div className='flex flex-col gap-1.5'>
                  <Label htmlFor='knowledge-embedding-model'>
                    {t('Embedding model')}
                  </Label>
                  <Input
                    id='knowledge-embedding-model'
                    maxLength={100}
                    onChange={(event) => setEmbeddingModel(event.target.value)}
                    placeholder='text-embedding-3-small'
                    value={embeddingModel}
                  />
                </div>
              </div>
              <div className='flex justify-end'>
                <Button
                  disabled={busy !== null}
                  onClick={() => void handleCreateBase()}
                  size='sm'
                  type='button'
                >
                  {busy === 'create-base' && (
                    <Loader2 aria-hidden='true' className='animate-spin' />
                  )}
                  {t('Create knowledge base')}
                </Button>
              </div>
            </div>

            {basesQuery.isPending && (
              <LoadingState message={t('Loading knowledge bases...')} />
            )}
            {basesQuery.isError && (
              <ErrorState
                description={getServerMessage(basesQuery.error)}
                onRetry={() => void basesQuery.refetch()}
                title={t('Knowledge bases could not be loaded.')}
              />
            )}
            {!basesQuery.isPending &&
              !basesQuery.isError &&
              bases.length === 0 && (
                <EmptyState
                  description={t(
                    'Create a knowledge base to upload documents for retrieval.'
                  )}
                  icon={Database}
                  title={t('No knowledge bases yet')}
                />
              )}
            {bases.length > 0 && (
              <div className='flex flex-col gap-2'>
                <p className='text-sm font-medium'>
                  {t('Your knowledge bases')}
                </p>
                {bases.map((base) => (
                  <div
                    className='flex items-center gap-2 rounded-lg border p-2'
                    key={base.id}
                  >
                    <Button
                      aria-pressed={base.id === selectedBaseId}
                      className='h-auto min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-1 text-left'
                      onClick={() => setSelectedBaseId(base.id)}
                      type='button'
                      variant={
                        base.id === selectedBaseId ? 'secondary' : 'ghost'
                      }
                    >
                      <span className='max-w-full truncate font-medium'>
                        {base.name}
                      </span>
                      <span className='text-muted-foreground max-w-full truncate text-xs'>
                        {base.embeddingModel} ·{' '}
                        {t(
                          '{{documents}} documents · {{chunks}} chunks · {{bytes}}',
                          {
                            documents: formatNumber(base.documentCount, locale),
                            chunks: formatNumber(base.chunkCount, locale),
                            bytes: formatBytes(base.byteSize, locale),
                          }
                        )}
                      </span>
                    </Button>
                    <Button
                      aria-label={t('Delete {{name}}', { name: base.name })}
                      disabled={busy !== null}
                      onClick={() =>
                        setPendingDelete({
                          kind: 'base',
                          id: base.id,
                          name: base.name,
                        })
                      }
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <Trash2 aria-hidden='true' />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {selectedBase !== null && (
              <div className='flex flex-col gap-3'>
                <div className='flex items-center justify-between gap-3'>
                  <div className='min-w-0'>
                    <p className='truncate text-sm font-medium'>
                      {selectedBase.name}
                    </p>
                    <p className='text-muted-foreground text-xs'>
                      {t('{{count}} documents', {
                        count: formatNumber(selectedBase.documentCount, locale),
                      })}
                    </p>
                  </div>
                  <input
                    accept={PLAYGROUND_DOCUMENT_ACCEPT}
                    aria-label={t('Upload knowledge base document')}
                    className='hidden'
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void handleUpload(file)
                      event.target.value = ''
                    }}
                    ref={fileInputRef}
                    type='file'
                  />
                  <Button
                    disabled={busy !== null}
                    onClick={() => fileInputRef.current?.click()}
                    size='sm'
                    type='button'
                  >
                    {busy === 'upload' ? (
                      <Loader2 aria-hidden='true' className='animate-spin' />
                    ) : (
                      <Upload aria-hidden='true' />
                    )}
                    {t('Upload document')}
                  </Button>
                </div>

                {progress !== null && (
                  <div className='flex flex-col gap-1'>
                    <p className='text-muted-foreground text-xs'>
                      {t('Embedding {{done}} of {{total}} chunks...', {
                        done: formatNumber(progress.completed, locale),
                        total: formatNumber(progress.total, locale),
                      })}
                    </p>
                    <Progress aria-hidden='true' value={indexingProgress} />
                  </div>
                )}

                {documentsQuery.isPending && (
                  <LoadingState message={t('Loading documents...')} />
                )}
                {documentsQuery.isError && (
                  <ErrorState
                    description={getServerMessage(documentsQuery.error)}
                    onRetry={() => void documentsQuery.refetch()}
                    title={t('Documents could not be loaded.')}
                  />
                )}
                {!documentsQuery.isPending &&
                  !documentsQuery.isError &&
                  documents.length === 0 && (
                    <EmptyState
                      description={t(
                        'Upload a PDF, Markdown or text file to index it.'
                      )}
                      icon={Database}
                      title={t('No documents yet')}
                    />
                  )}
                {documents.map((document) => (
                  <KnowledgeDocumentRow
                    busy={
                      busy === `index:${document.id}` ||
                      busy === `delete:${document.id}`
                    }
                    document={document}
                    embeddingModel={selectedBase.embeddingModel}
                    key={document.id}
                    locale={locale}
                    onDelete={(item) =>
                      setPendingDelete({
                        kind: 'document',
                        id: item.id,
                        name: item.filename,
                      })
                    }
                    onRetry={(item) => void handleRetry(item)}
                  />
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        desc={t(
          'This permanently deletes {{name}} and everything stored inside it.',
          { name: pendingDelete?.name ?? '' }
        )}
        destructive
        handleConfirm={() => void handleConfirmDelete()}
        isLoading={busy !== null && pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'base'
            ? t('Delete knowledge base?')
            : t('Delete document?')
        }
      />
    </>
  )
}
