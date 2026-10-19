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
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerMessage } from '@/lib/server-error-message'

import {
  createPlaygroundMemory,
  deletePlaygroundMemory,
  updatePlaygroundMemory,
} from '../../api'
import {
  PLAYGROUND_MEMORY_CATEGORIES,
  PLAYGROUND_MEMORY_CATEGORY_LABELS,
  PLAYGROUND_MEMORY_CONTENT_MAX_CHARS,
  PLAYGROUND_MEMORY_ERRORS,
} from '../../constants'
import { usePlaygroundMemories } from '../../hooks'
import { isChatModelOption, memoryCategoryLabel } from '../../lib'
import { playgroundQueryKeys } from '../../lib/query-keys'
import type {
  ModelOption,
  PlaygroundMemory,
  PlaygroundMemoryExtractionSettings,
} from '../../types'

interface PlaygroundMemoryPanelProps {
  /** Loads the list only while the Inspector shows this panel. */
  active: boolean
  disabled?: boolean
  userId: number | null
  models: ModelOption[]
  extraction: PlaygroundMemoryExtractionSettings
  onExtractionChange: (settings: PlaygroundMemoryExtractionSettings) => void
  /** Switches the workspace to the conversation that produced a memory. */
  onOpenSourceSession: (sessionId: string) => void
}

/**
 * The owner-scoped cross-session memory inside the Playground Inspector.
 * Memories are created here or proposed by the optional extraction call after
 * a reply; only enabled memories are injected into the next request. Every
 * write goes through the owner-checked `/api/playground/memories` endpoints.
 */
export function PlaygroundMemoryPanel(props: PlaygroundMemoryPanelProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const memoriesQuery = usePlaygroundMemories(props.userId, props.active)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PlaygroundMemory | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [draftCategory, setDraftCategory] = useState<string>('general')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PlaygroundMemory | null>(
    null
  )
  const [deleting, setDeleting] = useState(false)
  const [mutatingId, setMutatingId] = useState<string | null>(null)

  const listing = memoriesQuery.data
  const total = listing?.total ?? 0
  const limit = listing?.limit ?? 0
  const canCreate = limit <= 0 || total < limit

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: playgroundQueryKeys.memories(props.userId),
    })
    await queryClient.invalidateQueries({
      queryKey: playgroundQueryKeys.usage(props.userId),
    })
  }

  const openCreate = () => {
    setEditing(null)
    setDraftContent('')
    setDraftCategory('general')
    setEditorOpen(true)
  }

  const openEdit = (memory: PlaygroundMemory) => {
    setEditing(memory)
    setDraftContent(memory.content)
    setDraftCategory(
      (PLAYGROUND_MEMORY_CATEGORIES as readonly string[]).includes(
        memory.category
      )
        ? memory.category
        : 'general'
    )
    setEditorOpen(true)
  }

  const saveMemory = async () => {
    const content = draftContent.trim()
    if (!content) {
      toast.error(t('Memory content cannot be empty.'))
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await updatePlaygroundMemory(editing.id, {
          content,
          category: draftCategory,
        })
      } else {
        await createPlaygroundMemory({ content, category: draftCategory })
      }
      await refresh()
      setEditorOpen(false)
      toast.success(editing ? t('Memory saved') : t('Memory added'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_MEMORY_ERRORS.SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const toggleMemory = async (memory: PlaygroundMemory) => {
    setMutatingId(memory.id)
    try {
      await updatePlaygroundMemory(memory.id, { enabled: !memory.enabled })
      await refresh()
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_MEMORY_ERRORS.SAVE_FAILED))
    } finally {
      setMutatingId(null)
    }
  }

  const deleteMemory = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deletePlaygroundMemory(deleteTarget.id)
      await refresh()
      setDeleteTarget(null)
      toast.success(t('Memory deleted'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_MEMORY_ERRORS.DELETE_FAILED))
    } finally {
      setDeleting(false)
    }
  }

  const modelItems = [
    { value: '', label: t('Same as summary model') },
    ...props.models
      .filter((model) => model.value !== '' && isChatModelOption(model))
      .map((model) => ({ value: model.value, label: model.label })),
  ]
  if (
    props.extraction.model &&
    !modelItems.some((item) => item.value === props.extraction.model)
  ) {
    modelItems.push({
      value: props.extraction.model,
      label: props.extraction.model,
    })
  }

  const categoryItems = PLAYGROUND_MEMORY_CATEGORIES.map((value) => ({
    value,
    label: t(PLAYGROUND_MEMORY_CATEGORY_LABELS[value]),
  }))

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='flex items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='text-xs font-medium'>{t('Cross-session memory')}</span>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {limit > 0 ? t('{{used}} of {{limit}}', { used: total, limit }) : ''}
        </span>
      </div>

      <div className='grid gap-3 border-b px-3 py-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <Label htmlFor='playground-memory-extraction'>
              {t('Learn memories automatically')}
            </Label>
            <p className='text-muted-foreground mt-1 text-xs'>
              {t(
                'After each reply, your own messages are sent through a billed request to propose durable notes. Nothing is learned while this is off.'
              )}
            </p>
          </div>
          <Switch
            checked={props.extraction.enabled}
            disabled={props.disabled}
            id='playground-memory-extraction'
            onCheckedChange={(checked) =>
              props.onExtractionChange({
                ...props.extraction,
                enabled: checked,
              })
            }
          />
        </div>
        {props.extraction.enabled && (
          <div className='grid gap-2'>
            <Label htmlFor='playground-memory-model'>
              {t('Extraction model')}
            </Label>
            <Select
              items={modelItems}
              onValueChange={(value) => {
                if (typeof value !== 'string') return
                props.onExtractionChange({ ...props.extraction, model: value })
              }}
              value={props.extraction.model}
            >
              <SelectTrigger
                disabled={props.disabled}
                id='playground-memory-model'
                size='sm'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {modelItems.map((item) => (
                    <SelectItem
                      key={item.value || 'summary-model'}
                      value={item.value}
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className='flex items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='text-muted-foreground text-xs'>
          {t('Enabled memories are added to every new request.')}
        </span>
        <Button
          disabled={props.disabled || !canCreate}
          onClick={openCreate}
          size='sm'
          type='button'
          variant='outline'
        >
          <Plus aria-hidden='true' />
          {t('New memory')}
        </Button>
      </div>

      {memoriesQuery.isError && (
        <div className='shrink-0 p-2'>
          <ErrorState
            className='min-h-0 p-2'
            description={getServerMessage(memoriesQuery.error)}
            onRetry={() => void memoriesQuery.refetch()}
            title={t(PLAYGROUND_MEMORY_ERRORS.LOAD_FAILED)}
          />
        </div>
      )}

      {memoriesQuery.isPending && (
        <div className='flex min-h-0 flex-1 items-center justify-center p-4'>
          <LoadingState className='min-h-24' />
        </div>
      )}

      {memoriesQuery.isSuccess && total === 0 && (
        <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4'>
          <EmptyState
            description={t(
              'Durable notes you keep across conversations appear here. Enable automatic learning or add one by hand.'
            )}
            title={t('No memories yet')}
          />
          <Button
            disabled={props.disabled || !canCreate}
            onClick={openCreate}
            size='sm'
            type='button'
          >
            <Plus aria-hidden='true' />
            {t('New memory')}
          </Button>
        </div>
      )}

      {memoriesQuery.isSuccess && (listing?.items.length ?? 0) > 0 && (
        <ScrollArea className='min-h-0 flex-1'>
          <ul className='grid gap-2 p-3'>
            {listing?.items.map((memory) => (
              <li className='rounded-md border p-3' key={memory.id}>
                <div className='flex items-start gap-2'>
                  <div className='min-w-0 flex-1'>
                    <p className='text-sm break-words whitespace-pre-wrap'>
                      {memory.content}
                    </p>
                    <div className='mt-2 flex flex-wrap items-center gap-2'>
                      <Badge variant='secondary'>
                        {t(memoryCategoryLabel(memory.category))}
                      </Badge>
                      {memory.sourceSessionId && (
                        <Button
                          className='h-auto px-0'
                          onClick={() => {
                            if (memory.sourceSessionId) {
                              props.onOpenSourceSession(memory.sourceSessionId)
                            }
                          }}
                          size='sm'
                          type='button'
                          variant='link'
                        >
                          <ExternalLink aria-hidden='true' />
                          {t('View source conversation')}
                        </Button>
                      )}
                    </div>
                  </div>
                  <Switch
                    aria-label={t('Include this memory in requests')}
                    checked={memory.enabled}
                    disabled={props.disabled || mutatingId === memory.id}
                    onCheckedChange={() => void toggleMemory(memory)}
                  />
                </div>
                <div className='mt-2 flex items-center justify-end gap-1'>
                  <Button
                    aria-label={t('Edit memory')}
                    disabled={props.disabled}
                    onClick={() => openEdit(memory)}
                    size='icon-sm'
                    type='button'
                    variant='ghost'
                  >
                    <Pencil aria-hidden='true' />
                  </Button>
                  <Button
                    aria-label={t('Delete memory')}
                    disabled={props.disabled}
                    onClick={() => setDeleteTarget(memory)}
                    size='icon-sm'
                    type='button'
                    variant='ghost'
                  >
                    <Trash2 aria-hidden='true' />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}

      <Dialog
        description={t(
          'Durable facts and preferences the assistant can reuse in other conversations.'
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
              disabled={saving || !draftContent.trim()}
              onClick={() => void saveMemory()}
              type='button'
            >
              {t('Save')}
            </Button>
          </>
        }
        onOpenChange={(open) => {
          if (!saving) setEditorOpen(open)
        }}
        open={editorOpen}
        title={editing ? t('Edit memory') : t('New memory')}
      >
        <div className='grid gap-4'>
          <div className='grid gap-2'>
            <Label htmlFor='playground-memory-content'>
              {t('Memory content')}
            </Label>
            <Textarea
              className='min-h-28'
              id='playground-memory-content'
              maxLength={PLAYGROUND_MEMORY_CONTENT_MAX_CHARS}
              onChange={(event) => setDraftContent(event.target.value)}
              placeholder={t('e.g. Prefers concise answers in English.')}
              value={draftContent}
            />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='playground-memory-category'>{t('Category')}</Label>
            <Select
              items={categoryItems}
              onValueChange={(value) => {
                if (typeof value === 'string') setDraftCategory(value)
              }}
              value={draftCategory}
            >
              <SelectTrigger id='playground-memory-category' size='sm'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {categoryItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        confirmText={t('Delete')}
        desc={t('This memory will be deleted from your account.')}
        destructive
        handleConfirm={() => void deleteMemory()}
        isLoading={deleting}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
        open={deleteTarget !== null}
        title={t('Delete memory?')}
      />
    </div>
  )
}
