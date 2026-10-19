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
  Copy,
  Download,
  LayoutTemplate,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { formatBytes } from '@/lib/format'
import { ROLE } from '@/lib/roles'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  copyCanvasTemplateFromMarket,
  createCanvasTemplate,
  createGlobalCanvasTemplate,
  deleteCanvasTemplate,
  deleteGlobalCanvasTemplate,
  exportCanvasTemplate,
  getCanvasTemplate,
  importCanvasTemplate,
  listCanvasTemplateMarket,
  listCanvasTemplates,
  listGlobalCanvasTemplates,
  updateCanvasTemplate,
  updateGlobalCanvasTemplate,
} from '../api'
import type { CanvasTemplateDetail, CanvasTemplateSummary } from '../types'

type TemplateTab = 'mine' | 'market' | 'global'

interface CanvasTemplateLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canvasId: string
  canvasTitle: string
  disabled?: boolean
  /** Saves pending editor changes before the server snapshots the canvas. */
  onFlush: () => Promise<void>
  onApplyToCurrent: (
    template: CanvasTemplateDetail
  ) => Promise<{ droppedRefs: number }>
  onCreateFromTemplate: (
    template: CanvasTemplateDetail
  ) => Promise<{ droppedRefs: number }>
}

function downloadTemplate(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function CanvasTemplateLibraryDialog(
  props: CanvasTemplateLibraryDialogProps
) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language || 'en')
  const isAdmin = useAuthStore(
    (state) => (state.auth.user?.role ?? 0) >= ROLE.ADMIN
  )
  const [tab, setTab] = useState<TemplateTab>('mine')
  const [items, setItems] = useState<CanvasTemplateSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] =
    useState<CanvasTemplateSummary | null>(null)
  const [editTarget, setEditTarget] = useState<CanvasTemplateSummary | null>(
    null
  )
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [inlineAssets, setInlineAssets] = useState(false)
  const [saving, setSaving] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!props.open) return
    setName(props.canvasTitle)
    setDescription('')
    setCategory('')
    setInlineAssets(false)
    setEditTarget(null)
  }, [props.canvasTitle, props.open])

  useEffect(() => {
    if (!props.open) return
    const controller = new AbortController()
    const load =
      tab === 'mine'
        ? listCanvasTemplates
        : tab === 'market'
          ? listCanvasTemplateMarket
          : listGlobalCanvasTemplates
    setLoading(true)
    setError(null)
    void load(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setItems(next)
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            getServerMessage(loadError) ?? t('Unable to load canvas templates.')
          )
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [props.open, refresh, tab, t])

  const reportError = useCallback(
    (cause: unknown) => {
      toast.error(t(getServerMessage(cause) ?? 'Canvas operation failed.'))
    },
    [t]
  )

  const handleSave = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const templateName = name.trim()
      if (!templateName) return
      setSaving(true)
      const global = tab === 'global'
      try {
        await props.onFlush()
        const input = {
          canvasId: props.canvasId,
          name: templateName,
          description: description.trim() || undefined,
          category: category.trim() || undefined,
          inlineAssets,
        }
        const result = global
          ? await createGlobalCanvasTemplate(input)
          : await createCanvasTemplate(input)
        toast.success(
          global ? t('Global template saved.') : t('Template saved.')
        )
        if (result.resourcesMissing > 0) {
          toast.warning(
            t('Some attachment references could not be saved in the template.')
          )
        } else if (result.referencesDropped > 0) {
          toast.info(
            t('Template saved without {{count}} live resource links.', {
              count: result.referencesDropped,
            })
          )
        }
        setTab(global ? 'global' : 'mine')
        setRefresh((value) => value + 1)
      } catch (saveError) {
        reportError(saveError)
      } finally {
        setSaving(false)
      }
    },
    [category, description, inlineAssets, name, props, reportError, t, tab]
  )

  const handleApply = useCallback(
    async (item: CanvasTemplateSummary, target: 'current' | 'new') => {
      const key = `${target}:${item.id}`
      setPending(key)
      try {
        const detail = await getCanvasTemplate(item.id)
        const result =
          target === 'current'
            ? await props.onApplyToCurrent(detail)
            : await props.onCreateFromTemplate(detail)
        toast.success(
          target === 'current'
            ? t('Applied to the current canvas.')
            : t('Created a new canvas from the template.')
        )
        if (result.droppedRefs > 0) {
          toast.warning(t('Some attachment references could not be restored.'))
        }
        props.onOpenChange(false)
      } catch (applyError) {
        reportError(applyError)
      } finally {
        setPending(null)
      }
    },
    [props, reportError, t]
  )

  const handleCopy = useCallback(
    async (item: CanvasTemplateSummary) => {
      setPending(`copy:${item.id}`)
      try {
        await copyCanvasTemplateFromMarket(item.id)
        toast.success(t('Template copied to your library.'))
        setRefresh((value) => value + 1)
      } catch (copyError) {
        reportError(copyError)
      } finally {
        setPending(null)
      }
    },
    [reportError, t]
  )

  const handleExport = useCallback(
    async (item: CanvasTemplateSummary) => {
      setPending(`export:${item.id}`)
      try {
        const download = await exportCanvasTemplate(item.id)
        downloadTemplate(download.filename, download.blob)
        toast.success(t('Template exported.'))
      } catch (exportError) {
        reportError(exportError)
      } finally {
        setPending(null)
      }
    },
    [reportError, t]
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setPending(`delete:${deleteTarget.id}`)
    try {
      if (deleteTarget.visibility === 'global') {
        await deleteGlobalCanvasTemplate(deleteTarget.id)
      } else {
        await deleteCanvasTemplate(deleteTarget.id)
      }
      toast.success(t('Template deleted.'))
      setDeleteTarget(null)
      setRefresh((value) => value + 1)
    } catch (deleteError) {
      reportError(deleteError)
    } finally {
      setPending(null)
    }
  }, [deleteTarget, reportError, t])

  const beginEdit = useCallback((item: CanvasTemplateSummary) => {
    setEditTarget(item)
    setEditName(item.name)
    setEditDescription(item.description)
    setEditCategory(item.category)
  }, [])

  const saveEdit = useCallback(async () => {
    if (!editTarget) return
    const templateName = editName.trim()
    if (!templateName) return
    setPending(`edit:${editTarget.id}`)
    try {
      const input = {
        name: templateName,
        description: editDescription.trim(),
        category: editCategory.trim(),
      }
      if (tab === 'global') {
        await updateGlobalCanvasTemplate(editTarget.id, input)
      } else {
        await updateCanvasTemplate(editTarget.id, input)
      }
      toast.success(t('Template updated.'))
      setEditTarget(null)
      setRefresh((value) => value + 1)
    } catch (editError) {
      reportError(editError)
    } finally {
      setPending(null)
    }
  }, [editCategory, editDescription, editName, editTarget, reportError, t, tab])

  const handleImport = useCallback(
    async (file: File) => {
      setPending('import')
      try {
        const global = tab === 'global'
        const result = await importCanvasTemplate(file, global)
        toast.success(
          global ? t('Global template imported.') : t('Template imported.')
        )
        if (result.resourcesMissing > 0) {
          toast.warning(t('Some attachment references could not be restored.'))
        }
        setTab(global ? 'global' : 'mine')
        setRefresh((value) => value + 1)
      } catch (importError) {
        reportError(importError)
      } finally {
        setPending(null)
      }
    },
    [reportError, t, tab]
  )

  const handleTabChange = (value: string) => {
    setTab(value as TemplateTab)
    setItems([])
    setLoading(true)
  }

  const editable = tab === 'mine' || (tab === 'global' && isAdmin)
  const emptyDescription =
    tab === 'mine'
      ? t('Save the current canvas or import a template archive.')
      : tab === 'market'
        ? t('Official templates are ready to use on any canvas.')
        : t('Global templates are shared with every account.')
  const saveTitle =
    tab === 'global'
      ? t('Save current canvas as a global template')
      : t('Save current canvas as a template')
  const saveLabel =
    tab === 'global' ? t('Save as global template') : t('Save as template')
  const saveForm = (
    <form
      className='grid gap-3 rounded-lg border p-3'
      onSubmit={(event) => void handleSave(event)}
    >
      <div className='text-sm font-medium'>{saveTitle}</div>
      <Input
        aria-label={t('Template name')}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('Template name')}
        required
        value={name}
      />
      <Textarea
        aria-label={t('Template description')}
        maxLength={2000}
        onChange={(event) => setDescription(event.target.value)}
        placeholder={t('Template description (optional)')}
        value={description}
      />
      <div className='flex flex-wrap items-center gap-3'>
        <Input
          aria-label={t('Template category')}
          className='w-48'
          maxLength={32}
          onChange={(event) => setCategory(event.target.value)}
          placeholder={t('e.g. translation')}
          value={category}
        />
        <label className='flex items-center gap-2 text-sm'>
          <Switch
            checked={inlineAssets}
            onCheckedChange={setInlineAssets}
            size='sm'
          />
          {t('Include attachment files')}
        </label>
      </div>
      <p className='text-muted-foreground text-xs'>
        {inlineAssets
          ? t(
              'The template stores a copy of its attachment files. Applying it uploads those files into the target canvas.'
            )
          : t(
              'Only the chain structure is saved. Attachment references and their files are not included.'
            )}
      </p>
      <div>
        <Button
          disabled={saving || props.disabled || !name.trim()}
          size='sm'
          type='submit'
        >
          {saving ? t('Saving...') : saveLabel}
        </Button>
      </div>
    </form>
  )

  let listBody: ReactNode
  if (loading) {
    listBody = <LoadingState className='min-h-32' />
  } else if (error) {
    listBody = (
      <ErrorState
        className='min-h-32'
        description={error}
        onRetry={() => setRefresh((value) => value + 1)}
      />
    )
  } else if (items.length === 0) {
    listBody = (
      <EmptyState
        className='min-h-32'
        description={emptyDescription}
        title={
          tab === 'mine'
            ? t('No templates yet')
            : tab === 'market'
              ? t('No official templates yet')
              : t('No global templates yet')
        }
      />
    )
  } else {
    listBody = (
      <div className='grid gap-2'>
        {items.map((item) => {
          const editing = editTarget?.id === item.id
          const busy = pending !== null
          return (
            <div className='rounded-lg border p-3' key={item.id}>
              {editing ? (
                <div className='grid gap-2'>
                  <Input
                    aria-label={t('Template name')}
                    maxLength={100}
                    onChange={(event) => setEditName(event.target.value)}
                    value={editName}
                  />
                  <Textarea
                    aria-label={t('Template description')}
                    maxLength={2000}
                    onChange={(event) => setEditDescription(event.target.value)}
                    placeholder={t('Template description (optional)')}
                    value={editDescription}
                  />
                  <Input
                    aria-label={t('Template category')}
                    maxLength={32}
                    onChange={(event) => setEditCategory(event.target.value)}
                    placeholder={t('e.g. translation')}
                    value={editCategory}
                  />
                  <div className='flex justify-end gap-2'>
                    <Button
                      onClick={() => setEditTarget(null)}
                      size='sm'
                      type='button'
                      variant='outline'
                    >
                      {t('Cancel')}
                    </Button>
                    <Button
                      disabled={busy || !editName.trim()}
                      onClick={() => void saveEdit()}
                      size='sm'
                      type='button'
                    >
                      {t('Save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className='flex items-start justify-between gap-3'>
                  <div className='grid min-w-0 gap-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='truncate text-sm font-medium'>
                        {item.name}
                      </span>
                      {item.inlineAssets ? (
                        <Badge variant='secondary'>{t('Inline assets')}</Badge>
                      ) : null}
                    </div>
                    {item.description ? (
                      <p className='text-muted-foreground line-clamp-2 text-sm'>
                        {item.description}
                      </p>
                    ) : null}
                    <span className='text-muted-foreground text-xs'>
                      {t('{{nodes}} nodes, {{edges}} edges', {
                        nodes: item.nodeCount,
                        edges: item.edgeCount,
                      })}
                      {item.assetCount > 0
                        ? ` · ${t('{{count}} files', {
                            count: item.assetCount,
                          })} · ${formatBytes(item.assetBytes, locale)}`
                        : ''}
                    </span>
                  </div>
                  <div className='flex shrink-0 flex-wrap justify-end gap-1'>
                    <Button
                      disabled={busy || props.disabled}
                      onClick={() => void handleApply(item, 'current')}
                      size='sm'
                      type='button'
                    >
                      {pending === `current:${item.id}`
                        ? t('Applying...')
                        : t('Apply')}
                    </Button>
                    <Button
                      disabled={busy || props.disabled}
                      onClick={() => void handleApply(item, 'new')}
                      size='sm'
                      type='button'
                      variant='outline'
                    >
                      {t('New canvas')}
                    </Button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            aria-label={t('Template actions')}
                            disabled={busy}
                            size='icon-sm'
                            type='button'
                            variant='outline'
                          />
                        }
                      >
                        <LayoutTemplate aria-hidden='true' />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end' className='w-48'>
                        <DropdownMenuItem
                          onClick={() => void handleExport(item)}
                        >
                          <Download aria-hidden='true' />
                          {t('Export template')}
                        </DropdownMenuItem>
                        {tab === 'market' ? (
                          <DropdownMenuItem
                            onClick={() => void handleCopy(item)}
                          >
                            <Copy aria-hidden='true' />
                            {t('Copy to my templates')}
                          </DropdownMenuItem>
                        ) : null}
                        {editable ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => beginEdit(item)}>
                              <Pencil aria-hidden='true' />
                              {t('Rename template')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(item)}
                              variant='destructive'
                            >
                              <Trash2 aria-hidden='true' />
                              {t('Delete template')}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <Dialog
        contentClassName='sm:max-w-3xl'
        contentHeight='min(68vh, 620px)'
        description={t('Reuse a saved chain on this canvas or a new one.')}
        onOpenChange={props.onOpenChange}
        open={props.open}
        title={t('Canvas templates')}
      >
        <Tabs onValueChange={handleTabChange} value={tab}>
          <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
            <TabsList>
              <TabsTrigger value='mine'>{t('My templates')}</TabsTrigger>
              <TabsTrigger value='market'>
                {t('Official templates')}
              </TabsTrigger>
              {isAdmin ? (
                <TabsTrigger value='global'>{t('Manage global')}</TabsTrigger>
              ) : null}
            </TabsList>
            <div>
              <input
                accept='.zip,application/zip'
                aria-label={t('Template archive file')}
                className='hidden'
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleImport(file)
                  event.target.value = ''
                }}
                ref={importRef}
                type='file'
              />
              <Button
                disabled={pending !== null || props.disabled}
                onClick={() => importRef.current?.click()}
                size='sm'
                type='button'
                variant='outline'
              >
                <Upload aria-hidden='true' />
                {tab === 'global'
                  ? t('Import global template')
                  : t('Import template')}
              </Button>
            </div>
          </div>

          <TabsContent className='grid gap-3' value='mine'>
            {saveForm}
            {listBody}
          </TabsContent>
          <TabsContent className='grid gap-3' value='market'>
            {listBody}
          </TabsContent>
          {isAdmin ? (
            <TabsContent className='grid gap-3' value='global'>
              {saveForm}
              {listBody}
            </TabsContent>
          ) : null}
        </Tabs>
      </Dialog>

      <ConfirmDialog
        desc={t('Delete this template? This cannot be undone.')}
        destructive
        handleConfirm={() => void confirmDelete()}
        isLoading={pending !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        open={deleteTarget !== null}
        title={t('Delete template?')}
      />
    </>
  )
}
