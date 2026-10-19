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
  BookMarkedIcon,
  Download,
  HistoryIcon,
  MessageSquareTextIcon,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerMessage } from '@/lib/server-error-message'

import {
  createPlaygroundSnippet,
  deletePlaygroundSnippet,
  getPlaygroundSnippet,
  getPlaygroundSnippets,
  importPlaygroundSnippet,
  rollbackPlaygroundSnippet,
  updatePlaygroundSnippet,
} from '../../api'
import type { PlaygroundSnippetInput } from '../../api'
import {
  PLAYGROUND_SNIPPET_ERRORS,
  PLAYGROUND_SNIPPET_NAME_MAX_LENGTH,
} from '../../constants'
import { exportPlaygroundSnippetFile } from '../../lib/export'
import { parsePromptTemplateVariables } from '../../lib/input/prompt-template'
import {
  parsePromptSnippetFile,
  PROMPT_SNIPPET_FILE_ERROR,
} from '../../lib/input/prompt-template-file'
import type { PromptSnippet, PromptSnippetDetail } from '../../types'
import { PlaygroundSnippetFillDialog } from './playground-snippet-fill-dialog'
import type { PromptSnippetTarget } from './playground-snippet-fill-dialog'
import { PlaygroundSnippetHistoryDialog } from './playground-snippet-history-dialog'

interface PlaygroundSnippetPanelProps {
  disabled?: boolean
  /** Appends the rendered snippet text to the composer draft. */
  onInsertSnippet: (content: string) => void
  /** Current published system prompt of the active conversation. */
  systemPrompt?: string
  /** Persists a prompt applied to the active conversation. */
  onSystemPromptChange?: (value: string) => void
}

type LoadStatus = 'loading' | 'ready' | 'error'
type HistoryStatus = 'loading' | 'ready' | 'error'

type SnippetDraft = {
  name: string
  content: string
}

type FillTarget = {
  name: string
  content: string
  target: PromptSnippetTarget
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function snippetSummary(detail: PromptSnippetDetail): PromptSnippet {
  return {
    id: detail.id,
    name: detail.name,
    content: detail.content,
    currentVersion: detail.currentVersion,
    productionVersion: detail.productionVersion,
    versionCount: detail.versionCount,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  }
}

/**
 * The account's prompt template library inside the Composer. A snippet is a
 * reusable fragment that may declare `{{variable}}` placeholders; inserting
 * one only fills the composer or the system prompt, while every write goes
 * through the owner-checked `/api/playground/snippets` endpoints. Each content
 * save appends an immutable version, and the history dialog can move the
 * production pointer back without rewriting stored revisions.
 */
export function PlaygroundSnippetPanel(props: PlaygroundSnippetPanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [snippets, setSnippets] = useState<PromptSnippet[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(0)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PromptSnippet | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PromptSnippet | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState<SnippetDraft>({ name: '', content: '' })
  const [importing, setImporting] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [fillTarget, setFillTarget] = useState<FillTarget | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historySnippet, setHistorySnippet] =
    useState<PromptSnippetDetail | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('loading')
  const [historyError, setHistoryError] = useState<Error | null>(null)
  const [rollingBackVersion, setRollingBackVersion] = useState<number | null>(
    null
  )
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStatus('loading')
    setLoadError(null)
    void getPlaygroundSnippets()
      .then((result) => {
        if (cancelled) return
        setSnippets(result.items)
        setTotal(result.total)
        setLimit(result.limit)
        setStatus('ready')
      })
      .catch((error) => {
        if (cancelled) return
        setLoadError(toError(error))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [open, refreshKey])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setQuery('')
  }

  const applyContent = (content: string, target: PromptSnippetTarget) => {
    if (target === 'system') {
      if (!props.onSystemPromptChange) return
      const existing = (props.systemPrompt ?? '').trimEnd()
      props.onSystemPromptChange(
        existing ? `${existing}\n\n${content}` : content
      )
      toast.success(t('Prompt snippet inserted into the system prompt'))
    } else {
      props.onInsertSnippet(content)
      toast.success(t('Prompt snippet inserted'))
    }
    handleOpenChange(false)
    setFillTarget(null)
  }

  const requestApply = (
    snippet: PromptSnippet,
    target: PromptSnippetTarget
  ) => {
    if (parsePromptTemplateVariables(snippet.content).length === 0) {
      applyContent(snippet.content, target)
      return
    }
    setFillTarget({
      name: snippet.name,
      content: snippet.content,
      target,
    })
  }

  const loadHistory = async (snippetId: string) => {
    setHistoryStatus('loading')
    setHistoryError(null)
    try {
      const detail = await getPlaygroundSnippet(snippetId)
      setHistorySnippet(detail)
      setHistoryStatus('ready')
    } catch (error) {
      setHistoryError(toError(error))
      setHistoryStatus('error')
    }
  }

  const openHistory = (snippet: PromptSnippet) => {
    setHistorySnippet(null)
    setHistoryOpen(true)
    void loadHistory(snippet.id)
  }

  const rollbackTo = async (version: number) => {
    if (!historySnippet) return
    setRollingBackVersion(version)
    try {
      const detail = await rollbackPlaygroundSnippet(historySnippet.id, version)
      setHistorySnippet(detail)
      setSnippets((current) =>
        current.map((item) =>
          item.id === detail.id ? snippetSummary(detail) : item
        )
      )
      toast.success(t('Prompt snippet rolled back'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_SNIPPET_ERRORS.ROLLBACK_FAILED))
    } finally {
      setRollingBackVersion(null)
    }
  }

  const openCreate = () => {
    setEditing(null)
    setDraft({ name: '', content: '' })
    setEditorOpen(true)
  }

  const openEdit = (snippet: PromptSnippet) => {
    setEditing(snippet)
    setDraft({ name: snippet.name, content: snippet.content })
    setEditorOpen(true)
  }

  const saveSnippet = async () => {
    // The server validates the same rules; this only avoids an empty round
    // trip and gives field-level feedback before it.
    const name = draft.name.trim()
    if (!name) {
      toast.error(t('Prompt snippet name must contain 1 to 100 characters.'))
      return
    }
    if (!draft.content.trim()) {
      toast.error(t('Prompt snippet text must not be empty.'))
      return
    }
    const input: PlaygroundSnippetInput = { name, content: draft.content }
    setSaving(true)
    try {
      if (editing) {
        const updated = await updatePlaygroundSnippet(editing.id, input)
        setSnippets((current) =>
          current.map((item) => (item.id === updated.id ? updated : item))
        )
      } else {
        const created = await createPlaygroundSnippet(input)
        setSnippets((current) => [created, ...current])
        setTotal((current) => current + 1)
      }
      setEditorOpen(false)
      toast.success(t('Prompt snippet saved'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_SNIPPET_ERRORS.SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const deleteSnippet = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deletePlaygroundSnippet(deleteTarget.id)
      setSnippets((current) =>
        current.filter((item) => item.id !== deleteTarget.id)
      )
      setTotal((current) => Math.max(0, current - 1))
      setDeleteTarget(null)
      toast.success(t('Prompt snippet deleted'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_SNIPPET_ERRORS.DELETE_FAILED))
    } finally {
      setDeleting(false)
    }
  }

  const exportSnippet = async (snippet: PromptSnippet) => {
    setExportingId(snippet.id)
    try {
      await exportPlaygroundSnippetFile(snippet.id)
      toast.success(t('Prompt snippet exported'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_SNIPPET_ERRORS.EXPORT_FAILED))
    } finally {
      setExportingId(null)
    }
  }

  const importSnippet = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const content = await file.text()
      parsePromptSnippetFile(content)
      const imported = await importPlaygroundSnippet(content)
      setSnippets((current) => [snippetSummary(imported), ...current])
      setTotal((current) => current + 1)
      toast.success(t('Prompt snippet imported'))
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === PROMPT_SNIPPET_FILE_ERROR
      ) {
        toast.error(t(PROMPT_SNIPPET_FILE_ERROR))
      } else {
        handleServerError(error, t(PLAYGROUND_SNIPPET_ERRORS.IMPORT_FAILED))
      }
    } finally {
      setImporting(false)
      input.value = ''
    }
  }

  const canCreate = limit <= 0 || total < limit
  const canApplySystemPrompt = Boolean(props.onSystemPromptChange)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleSnippets = normalizedQuery
    ? snippets.filter(
        (snippet) =>
          snippet.name.toLowerCase().includes(normalizedQuery) ||
          snippet.content.toLowerCase().includes(normalizedQuery)
      )
    : snippets

  const trigger = (
    <PromptInputButton
      aria-label={t('Prompt snippets')}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <BookMarkedIcon size={16} />
    </PromptInputButton>
  )

  const content = (
    <div className='flex max-h-[70vh] min-h-0 flex-col gap-2'>
      <div className='flex items-center justify-between gap-2 px-1'>
        <span className='text-sm font-semibold'>{t('Prompt snippets')}</span>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {limit > 0 ? t('{{used}} of {{limit}}', { used: total, limit }) : ''}
        </span>
      </div>

      <div className='flex items-center gap-2 px-1'>
        <Input
          aria-label={t('Search prompt snippets')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('Search prompt snippets')}
          value={query}
        />
        <input
          accept='.json,application/json'
          aria-label={t('Prompt snippet file')}
          className='hidden'
          onChange={(event) => void importSnippet(event)}
          ref={fileInputRef}
          type='file'
        />
        <Button
          aria-label={t('Import')}
          disabled={props.disabled || importing || !canCreate}
          onClick={() => fileInputRef.current?.click()}
          size='icon-sm'
          title={t('Import')}
          type='button'
          variant='outline'
        >
          <Upload aria-hidden='true' />
        </Button>
        <Button
          disabled={props.disabled || !canCreate}
          onClick={openCreate}
          size='sm'
          type='button'
          variant='outline'
        >
          <Plus aria-hidden='true' />
          {t('New snippet')}
        </Button>
      </div>

      {status === 'error' && (
        <ErrorState
          className='min-h-0 p-2'
          description={getServerMessage(loadError)}
          onRetry={() => setRefreshKey((value) => value + 1)}
          title={t(PLAYGROUND_SNIPPET_ERRORS.LOAD_FAILED)}
        />
      )}

      {status === 'ready' && snippets.length === 0 && (
        <EmptyState
          description={t(
            'Create a snippet to reuse a prompt fragment across conversations.'
          )}
          title={t('No prompt snippets yet')}
        />
      )}

      {status === 'ready' &&
        snippets.length > 0 &&
        visibleSnippets.length === 0 && (
          <EmptyState
            description={t('Try a different search term.')}
            title={t('No matching prompt snippets')}
          />
        )}

      {(status === 'loading' || visibleSnippets.length > 0) && (
        <ScrollArea className='h-64 min-h-0'>
          <ul className='grid gap-2 px-1'>
            {status === 'loading' && <LoadingState className='min-h-24' />}
            {visibleSnippets.map((snippet) => (
              <li className='rounded-md border p-2' key={snippet.id}>
                <div className='flex min-w-0 items-start justify-between gap-2'>
                  <p className='min-w-0 truncate text-sm font-medium'>
                    {snippet.name}
                  </p>
                  <Badge className='shrink-0' variant='secondary'>
                    v{snippet.productionVersion}
                  </Badge>
                </div>
                <p className='text-muted-foreground mt-1 line-clamp-2 text-xs break-words whitespace-pre-wrap'>
                  {snippet.content}
                </p>
                <div className='mt-2 flex flex-wrap items-center justify-between gap-1'>
                  <div className='flex items-center gap-2'>
                    <Button
                      disabled={props.disabled}
                      onClick={() => requestApply(snippet, 'composer')}
                      size='sm'
                      type='button'
                      variant='secondary'
                    >
                      {t('Insert')}
                    </Button>
                    <span className='text-muted-foreground text-[11px]'>
                      {t('{{count}} versions', {
                        count: snippet.versionCount,
                      })}
                    </span>
                  </div>
                  <div className='flex items-center gap-1'>
                    {canApplySystemPrompt ? (
                      <Button
                        aria-label={t('Insert into system prompt')}
                        disabled={props.disabled}
                        onClick={() => requestApply(snippet, 'system')}
                        size='icon-sm'
                        type='button'
                        variant='ghost'
                      >
                        <MessageSquareTextIcon aria-hidden='true' />
                      </Button>
                    ) : null}
                    <Button
                      aria-label={t('Version history')}
                      disabled={props.disabled}
                      onClick={() => openHistory(snippet)}
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <HistoryIcon aria-hidden='true' />
                    </Button>
                    <Button
                      aria-label={t('Export snippet')}
                      disabled={props.disabled || exportingId === snippet.id}
                      onClick={() => void exportSnippet(snippet)}
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <Download aria-hidden='true' />
                    </Button>
                    <Button
                      aria-label={t('Edit snippet')}
                      disabled={props.disabled}
                      onClick={() => openEdit(snippet)}
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <Pencil aria-hidden='true' />
                    </Button>
                    <Button
                      aria-label={t('Delete snippet')}
                      disabled={props.disabled}
                      onClick={() => setDeleteTarget(snippet)}
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <Trash2 aria-hidden='true' />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )

  const dialogs = (
    <>
      <Dialog
        description={t(
          'Reusable prompt fragments that fill the composer but stay out of the conversation until you send them.'
        )}
        footer={
          <>
            <Button
              disabled={saving}
              onClick={() => setEditorOpen(false)}
              type='button'
              variant='outline'
            >
              {t('Cancel')}
            </Button>
            <Button
              disabled={saving || !draft.name.trim() || !draft.content.trim()}
              onClick={() => void saveSnippet()}
              type='button'
            >
              {t('Save')}
            </Button>
          </>
        }
        onOpenChange={(next) => {
          if (!saving) setEditorOpen(next)
        }}
        open={editorOpen}
        title={editing ? t('Edit snippet') : t('New snippet')}
      >
        <div className='grid gap-4'>
          <div className='grid gap-2'>
            <Label htmlFor='playground-snippet-name'>{t('Snippet name')}</Label>
            <Input
              id='playground-snippet-name'
              maxLength={PLAYGROUND_SNIPPET_NAME_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder={t('e.g. Review checklist')}
              value={draft.name}
            />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='playground-snippet-content'>
              {t('Snippet text')}
            </Label>
            <Textarea
              className='min-h-28'
              id='playground-snippet-content'
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  content: event.target.value,
                }))
              }
              placeholder={t(
                'e.g. Review this change for regressions. Variables use {{name}} or {{name:default}}.'
              )}
              value={draft.content}
            />
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        confirmText={t('Delete')}
        desc={t('This prompt snippet will be deleted from your account.')}
        destructive
        handleConfirm={() => void deleteSnippet()}
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteTarget(null)
        }}
        open={deleteTarget !== null}
        title={t('Delete snippet?')}
      />
    </>
  )

  const overlays = (
    <>
      {dialogs}
      <PlaygroundSnippetFillDialog
        content={fillTarget?.content ?? ''}
        onConfirm={(rendered) => {
          if (fillTarget) applyContent(rendered, fillTarget.target)
        }}
        onOpenChange={(next) => {
          if (!next) setFillTarget(null)
        }}
        open={fillTarget !== null}
        target={fillTarget?.target ?? 'composer'}
      />
      <PlaygroundSnippetHistoryDialog
        error={historyError}
        onOpenChange={setHistoryOpen}
        onRetry={() => {
          if (historySnippet) void loadHistory(historySnippet.id)
        }}
        onRollback={(version) => void rollbackTo(version)}
        open={historyOpen}
        rollingBackVersion={rollingBackVersion}
        snippet={historySnippet}
        status={historyStatus}
      />
    </>
  )

  const title = t('Prompt snippets')
  void title

  if (isMobile) {
    return (
      <>
        <Sheet onOpenChange={handleOpenChange} open={open}>
          <Tooltip>
            <TooltipTrigger render={<SheetTrigger render={trigger} />} />
            <TooltipContent>
              <p>{t('Prompt snippets')}</p>
            </TooltipContent>
          </Tooltip>
          <SheetContent
            className='max-h-[85vh] overflow-hidden rounded-t-xl'
            side='bottom'
          >
            <SheetHeader>
              <SheetTitle>{t('Prompt snippets')}</SheetTitle>
            </SheetHeader>
            {content}
          </SheetContent>
        </Sheet>
        {overlays}
      </>
    )
  }

  return (
    <>
      <Popover onOpenChange={handleOpenChange} open={open}>
        <Tooltip>
          <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Prompt snippets')}</p>
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
      {overlays}
    </>
  )
}
