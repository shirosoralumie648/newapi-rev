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
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { ModelSelector } from '@/components/model-group-selector'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerMessage } from '@/lib/server-error-message'

import {
  createPlaygroundPreset,
  deletePlaygroundPreset,
  getPlaygroundPresets,
  updatePlaygroundPreset,
} from '../../api'
import type { PlaygroundPresetInput } from '../../api'
import {
  PLAYGROUND_PRESET_AVATAR_MAX_LENGTH,
  PLAYGROUND_PRESET_ERRORS,
  PLAYGROUND_PRESET_NAME_MAX_LENGTH,
} from '../../constants'
import { presetAvatarUrl, presetInputFromSettings } from '../../lib'
import type {
  AssistantPreset,
  ModelOption,
  ParameterEnabled,
  PlaygroundConfig,
} from '../../types'
import { PlaygroundParameterContent } from '../input/playground-parameter-panel'

interface PlaygroundPresetPanelProps {
  /** Loads the list only while the Inspector shows this panel. */
  active: boolean
  disabled?: boolean
  models: ModelOption[]
  currentConfig: PlaygroundConfig
  currentParameterEnabled: ParameterEnabled
  currentSystemPrompt: string
  onApplyPreset: (preset: AssistantPreset) => void
  onCreateSession: (preset: AssistantPreset) => void
}

type LoadStatus = 'loading' | 'ready' | 'error'

type PresetDraft = {
  name: string
  avatar: string
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  systemPrompt: string
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function PresetAvatar(props: { avatar: string; name: string }) {
  const url = presetAvatarUrl(props.avatar.trim())
  if (url) {
    return (
      <img
        alt=''
        className='size-8 shrink-0 rounded-md object-cover'
        loading='lazy'
        referrerPolicy='no-referrer'
        src={url}
      />
    )
  }
  const text = props.avatar.trim() || props.name.trim().charAt(0).toUpperCase()
  return (
    <span
      aria-hidden='true'
      className='bg-muted flex size-8 shrink-0 items-center justify-center rounded-md text-sm'
    >
      {text || '🤖'}
    </span>
  )
}

/**
 * The owner-scoped assistant presets inside the Playground Inspector. A preset
 * can start a new conversation or replace the active conversation's model,
 * parameters and system prompt; every write goes through the owner-checked
 * `/api/playground/presets` endpoints.
 */
export function PlaygroundPresetPanel(props: PlaygroundPresetPanelProps) {
  const { t } = useTranslation()
  const [presets, setPresets] = useState<AssistantPreset[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(0)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<AssistantPreset | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AssistantPreset | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState<PresetDraft>(() => ({
    name: '',
    avatar: '',
    config: { ...props.currentConfig },
    parameterEnabled: { ...props.currentParameterEnabled },
    systemPrompt: props.currentSystemPrompt,
  }))

  useEffect(() => {
    if (!props.active) return
    let cancelled = false
    setStatus('loading')
    setLoadError(null)
    void getPlaygroundPresets()
      .then((result) => {
        if (cancelled) return
        setPresets(result.items)
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
  }, [props.active, refreshKey])

  const openCreate = () => {
    setEditing(null)
    // A new preset starts from the conversation's current settings, so saving
    // what already works takes one step.
    setDraft({
      name: '',
      avatar: '',
      config: { ...props.currentConfig },
      parameterEnabled: { ...props.currentParameterEnabled },
      systemPrompt: props.currentSystemPrompt,
    })
    setEditorOpen(true)
  }

  const openEdit = (preset: AssistantPreset) => {
    setEditing(preset)
    setDraft({
      name: preset.name,
      avatar: preset.avatar,
      config: { ...preset.config },
      parameterEnabled: { ...preset.parameterEnabled },
      systemPrompt: preset.systemPrompt,
    })
    setEditorOpen(true)
  }

  const savePreset = async () => {
    // The server validates the same rule; this only avoids an empty round trip.
    if (!draft.name.trim()) {
      toast.error(t('Assistant preset name must contain 1 to 100 characters.'))
      return
    }
    const input: PlaygroundPresetInput = presetInputFromSettings(
      draft.name,
      draft.avatar,
      {
        config: draft.config,
        parameterEnabled: draft.parameterEnabled,
        systemPrompt: draft.systemPrompt,
      }
    )
    setSaving(true)
    try {
      if (editing) {
        const updated = await updatePlaygroundPreset(editing.id, input)
        setPresets((current) =>
          current.map((item) => (item.id === updated.id ? updated : item))
        )
      } else {
        const created = await createPlaygroundPreset(input)
        setPresets((current) => [created, ...current])
        setTotal((current) => current + 1)
      }
      setEditorOpen(false)
      toast.success(t('Preset saved'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_PRESET_ERRORS.SAVE_FAILED))
    } finally {
      setSaving(false)
    }
  }

  const deletePreset = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deletePlaygroundPreset(deleteTarget.id)
      setPresets((current) =>
        current.filter((item) => item.id !== deleteTarget.id)
      )
      setTotal((current) => Math.max(0, current - 1))
      setDeleteTarget(null)
      toast.success(t('Preset deleted'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_PRESET_ERRORS.DELETE_FAILED))
    } finally {
      setDeleting(false)
    }
  }

  const canCreate = limit <= 0 || total < limit

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='flex items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='text-xs font-medium'>{t('Assistant presets')}</span>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {limit > 0 ? t('{{used}} of {{limit}}', { used: total, limit }) : ''}
        </span>
      </div>

      {status === 'error' && (
        <div className='shrink-0 p-2'>
          <ErrorState
            className='min-h-0 p-2'
            description={getServerMessage(loadError)}
            onRetry={() => setRefreshKey((value) => value + 1)}
            title={t(PLAYGROUND_PRESET_ERRORS.LOAD_FAILED)}
          />
        </div>
      )}

      {status === 'ready' && presets.length === 0 && (
        <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4'>
          <EmptyState
            description={t(
              'Create a preset to reuse a model, parameters and system prompt across conversations.'
            )}
            title={t('No assistant presets yet')}
          />
          <Button
            disabled={props.disabled || !canCreate}
            onClick={openCreate}
            size='sm'
            type='button'
          >
            <Plus aria-hidden='true' />
            {t('New preset')}
          </Button>
        </div>
      )}

      {(status === 'loading' || presets.length > 0) && (
        <>
          {presets.length > 0 && (
            <div className='flex justify-end border-b px-3 py-2'>
              <Button
                disabled={props.disabled || !canCreate}
                onClick={openCreate}
                size='sm'
                type='button'
                variant='outline'
              >
                <Plus aria-hidden='true' />
                {t('New preset')}
              </Button>
            </div>
          )}
          <ScrollArea className='min-h-0 flex-1'>
            <ul className='grid gap-2 p-3'>
              {status === 'loading' && <LoadingState className='min-h-24' />}
              {presets.map((preset) => (
                <li className='rounded-md border p-3' key={preset.id}>
                  <div className='flex items-start gap-2'>
                    <PresetAvatar avatar={preset.avatar} name={preset.name} />
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-sm font-medium'>
                        {preset.name}
                      </p>
                      <p className='text-muted-foreground truncate text-xs'>
                        {preset.config.model}
                      </p>
                      {preset.systemPrompt.trim() && (
                        <p className='text-muted-foreground mt-1 line-clamp-2 text-xs break-words whitespace-pre-wrap'>
                          {preset.systemPrompt}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className='mt-2 flex flex-wrap items-center gap-1'>
                    <Button
                      disabled={props.disabled}
                      onClick={() => props.onCreateSession(preset)}
                      size='sm'
                      type='button'
                    >
                      {t('New conversation')}
                    </Button>
                    <Button
                      disabled={props.disabled}
                      onClick={() => props.onApplyPreset(preset)}
                      size='sm'
                      type='button'
                      variant='outline'
                    >
                      {t('Apply to this conversation')}
                    </Button>
                    <Button
                      aria-label={t('Edit preset')}
                      className='ml-auto'
                      disabled={props.disabled}
                      onClick={() => openEdit(preset)}
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <Pencil aria-hidden='true' />
                    </Button>
                    <Button
                      aria-label={t('Delete preset')}
                      disabled={props.disabled}
                      onClick={() => setDeleteTarget(preset)}
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
        </>
      )}

      <Dialog
        description={t(
          'Reusable assistants with their own model, parameters and system prompt.'
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
              disabled={saving || !draft.name.trim()}
              onClick={() => void savePreset()}
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
        title={editing ? t('Edit preset') : t('New preset')}
      >
        <div className='grid gap-4'>
          <div className='grid gap-2'>
            <Label htmlFor='playground-preset-name'>{t('Preset name')}</Label>
            <Input
              id='playground-preset-name'
              maxLength={PLAYGROUND_PRESET_NAME_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder={t('e.g. Code reviewer')}
              value={draft.name}
            />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='playground-preset-avatar'>{t('Avatar')}</Label>
            <Input
              id='playground-preset-avatar'
              maxLength={PLAYGROUND_PRESET_AVATAR_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  avatar: event.target.value,
                }))
              }
              placeholder={t('Emoji or image URL')}
              value={draft.avatar}
            />
          </div>
          <div className='grid gap-2'>
            <Label>{t('Model')}</Label>
            <ModelSelector
              models={props.models}
              onModelChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  config: { ...current.config, model: value },
                }))
              }
              selectedModel={draft.config.model}
            />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='playground-preset-prompt'>
              {t('System prompt')}
            </Label>
            <Textarea
              className='min-h-28'
              id='playground-preset-prompt'
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  systemPrompt: event.target.value,
                }))
              }
              placeholder={t('e.g. You are a concise assistant.')}
              value={draft.systemPrompt}
            />
          </div>
          <div className='grid gap-3'>
            <div>
              <p className='text-sm font-medium'>{t('Parameters')}</p>
              <p className='text-muted-foreground text-xs'>
                {t('Only enabled parameters are sent with the request.')}
              </p>
            </div>
            <PlaygroundParameterContent
              config={draft.config}
              disabled={saving}
              onConfigChange={(key, value) =>
                setDraft((current) => ({
                  ...current,
                  config: { ...current.config, [key]: value },
                }))
              }
              onParameterEnabledChange={(key, value) =>
                setDraft((current) => ({
                  ...current,
                  parameterEnabled: {
                    ...current.parameterEnabled,
                    [key]: value,
                  },
                }))
              }
              parameterEnabled={draft.parameterEnabled}
            />
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        confirmText={t('Delete')}
        desc={t('This assistant preset will be deleted from your account.')}
        destructive
        handleConfirm={() => void deletePreset()}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
        open={deleteTarget !== null}
        title={t('Delete preset?')}
      />
    </div>
  )
}
