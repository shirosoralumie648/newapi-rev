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
import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { handleServerError } from '@/lib/handle-server-error'
import { ROLE } from '@/lib/roles'
import { getServerMessage } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

import {
  copyPlaygroundPresetToMine,
  createGlobalPlaygroundPreset,
  createPlaygroundPreset,
  deleteGlobalPlaygroundPreset,
  deletePlaygroundPreset,
  getGlobalPlaygroundPresets,
  getPlaygroundPresetMarket,
  getPlaygroundPresets,
  importPlaygroundPreset,
  updateGlobalPlaygroundPreset,
  updatePlaygroundPreset,
} from '../../api'
import type { PlaygroundPresetInput, PlaygroundPresetScope } from '../../api'
import {
  PLAYGROUND_PRESET_AVATAR_MAX_LENGTH,
  PLAYGROUND_PRESET_ERRORS,
  PLAYGROUND_PRESET_NAME_MAX_LENGTH,
} from '../../constants'
import {
  exportPlaygroundPresetFile,
  presetAvatarUrl,
  presetInputFromSettings,
} from '../../lib'
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
  currentOpeningMessage?: string
  currentSuggestedQuestions?: string[]
  onApplyPreset: (preset: AssistantPreset) => void
  onCreateSession: (preset: AssistantPreset) => void
}

type LoadStatus = 'loading' | 'ready' | 'error'
type PresetTab = 'private' | 'market' | 'global'

type PresetDraft = {
  name: string
  avatar: string
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  systemPrompt: string
  openingMessage: string
  suggestedQuestions: string
}

type DeleteTarget = {
  preset: AssistantPreset
  scope: PlaygroundPresetScope
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

interface PresetCardProps {
  preset: AssistantPreset
  scope: PresetTab
  disabled?: boolean
  onStart: () => void
  onApply: () => void
  onCopy?: () => void
  onEdit?: () => void
  onDelete?: () => void
  onExport?: () => void
}

function PresetCard(props: PresetCardProps) {
  const { t } = useTranslation()
  return (
    <li className='rounded-md border p-3'>
      <div className='flex items-start gap-2'>
        <PresetAvatar avatar={props.preset.avatar} name={props.preset.name} />
        <div className='min-w-0 flex-1'>
          <p className='truncate text-sm font-medium'>{props.preset.name}</p>
          <p className='text-muted-foreground truncate text-xs'>
            {props.preset.config.model}
          </p>
          {props.preset.systemPrompt.trim() && (
            <p className='text-muted-foreground mt-1 line-clamp-2 text-xs break-words whitespace-pre-wrap'>
              {props.preset.systemPrompt}
            </p>
          )}
          {props.preset.openingMessage.trim() && (
            <p className='text-muted-foreground mt-1 line-clamp-2 text-xs break-words whitespace-pre-wrap'>
              {props.preset.openingMessage}
            </p>
          )}
        </div>
      </div>
      <div className='mt-2 flex flex-wrap items-center gap-1'>
        <Button
          disabled={props.disabled}
          onClick={props.onStart}
          size='sm'
          type='button'
        >
          {t('New conversation')}
        </Button>
        <Button
          disabled={props.disabled}
          onClick={props.onApply}
          size='sm'
          type='button'
          variant='outline'
        >
          {t('Apply to this conversation')}
        </Button>
        {props.scope === 'market' && props.onCopy && (
          <Button
            disabled={props.disabled}
            onClick={props.onCopy}
            size='sm'
            type='button'
            variant='secondary'
          >
            {t('Copy to my presets')}
          </Button>
        )}
        {props.onExport && (
          <Button
            aria-label={t('Export preset')}
            className='ml-auto'
            disabled={props.disabled}
            onClick={props.onExport}
            size='icon-sm'
            type='button'
            variant='ghost'
          >
            <Download aria-hidden='true' />
          </Button>
        )}
        {props.onEdit && (
          <Button
            aria-label={t('Edit preset')}
            className={props.onExport ? undefined : 'ml-auto'}
            disabled={props.disabled}
            onClick={props.onEdit}
            size='icon-sm'
            type='button'
            variant='ghost'
          >
            <Pencil aria-hidden='true' />
          </Button>
        )}
        {props.onDelete && (
          <Button
            aria-label={t('Delete preset')}
            disabled={props.disabled}
            onClick={props.onDelete}
            size='icon-sm'
            type='button'
            variant='ghost'
          >
            <Trash2 aria-hidden='true' />
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * The assistant preset workspace inside the Playground Inspector. The private
 * tab edits the account's own presets, the market tab lets every account copy a
 * preset an administrator published, and the administrator tab maintains those
 * global presets. Every write still goes through the owner-checked preset
 * endpoints; this panel only carries display state.
 */
export function PlaygroundPresetPanel(props: PlaygroundPresetPanelProps) {
  const { t } = useTranslation()
  const role = useAuthStore((state) => state.auth.user?.role ?? ROLE.USER)
  const isAdmin = role >= ROLE.ADMIN
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<PresetTab>('private')
  const [presets, setPresets] = useState<AssistantPreset[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(0)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [market, setMarket] = useState<AssistantPreset[]>([])
  const [marketTotal, setMarketTotal] = useState(0)
  const [marketStatus, setMarketStatus] = useState<LoadStatus>('loading')
  const [marketError, setMarketError] = useState<Error | null>(null)
  const [globalPresets, setGlobalPresets] = useState<AssistantPreset[]>([])
  const [globalTotal, setGlobalTotal] = useState(0)
  const [globalStatus, setGlobalStatus] = useState<LoadStatus>('loading')
  const [globalError, setGlobalError] = useState<Error | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<AssistantPreset | null>(null)
  const [editingScope, setEditingScope] =
    useState<PlaygroundPresetScope>('private')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState<PresetDraft>(() => ({
    name: '',
    avatar: '',
    config: { ...props.currentConfig },
    parameterEnabled: { ...props.currentParameterEnabled },
    systemPrompt: props.currentSystemPrompt,
    openingMessage: props.currentOpeningMessage ?? '',
    suggestedQuestions: (props.currentSuggestedQuestions ?? []).join('\n'),
  }))

  useEffect(() => {
    if (!props.active) return
    let cancelled = false
    if (tab === 'private') {
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
    } else if (tab === 'market') {
      setMarketStatus('loading')
      setMarketError(null)
      void getPlaygroundPresetMarket()
        .then((result) => {
          if (cancelled) return
          setMarket(result.items)
          setMarketTotal(result.total)
          setMarketStatus('ready')
        })
        .catch((error) => {
          if (cancelled) return
          setMarketError(toError(error))
          setMarketStatus('error')
        })
    } else {
      setGlobalStatus('loading')
      setGlobalError(null)
      void getGlobalPlaygroundPresets()
        .then((result) => {
          if (cancelled) return
          setGlobalPresets(result.items)
          setGlobalTotal(result.total)
          setGlobalStatus('ready')
        })
        .catch((error) => {
          if (cancelled) return
          setGlobalError(toError(error))
          setGlobalStatus('error')
        })
    }
    return () => {
      cancelled = true
    }
  }, [props.active, refreshKey, tab])

  const openCreate = (scope: PlaygroundPresetScope) => {
    setEditing(null)
    setEditingScope(scope)
    // A new preset starts from the conversation's current settings, so saving
    // what already works takes one step.
    setDraft({
      name: '',
      avatar: '',
      config: { ...props.currentConfig },
      parameterEnabled: { ...props.currentParameterEnabled },
      systemPrompt: props.currentSystemPrompt,
      openingMessage: props.currentOpeningMessage ?? '',
      suggestedQuestions: (props.currentSuggestedQuestions ?? []).join('\n'),
    })
    setEditorOpen(true)
  }

  const openEdit = (preset: AssistantPreset, scope: PlaygroundPresetScope) => {
    setEditing(preset)
    setEditingScope(scope)
    setDraft({
      name: preset.name,
      avatar: preset.avatar,
      config: { ...preset.config },
      parameterEnabled: { ...preset.parameterEnabled },
      systemPrompt: preset.systemPrompt,
      openingMessage: preset.openingMessage,
      suggestedQuestions: preset.suggestedQuestions.join('\n'),
    })
    setEditorOpen(true)
  }

  const savePreset = async () => {
    // The server validates the same rules; this only avoids an empty round trip.
    if (!draft.name.trim()) {
      toast.error(t('Assistant preset name must contain 1 to 100 characters.'))
      return
    }
    const suggestedQuestions = draft.suggestedQuestions
      .split('\n')
      .map((question) => question.trim())
      .filter(Boolean)
    if (suggestedQuestions.length > 6) {
      toast.error(t('Up to 6 suggested questions are allowed.'))
      return
    }
    if (
      suggestedQuestions.some((question) => Array.from(question).length > 200)
    ) {
      toast.error(
        t('Each suggested question must contain 1 to 200 characters.')
      )
      return
    }
    if (new TextEncoder().encode(draft.openingMessage).length > 8 << 10) {
      toast.error(t('The opening message is too long.'))
      return
    }
    const input: PlaygroundPresetInput = presetInputFromSettings(
      draft.name,
      draft.avatar,
      {
        config: draft.config,
        parameterEnabled: draft.parameterEnabled,
        systemPrompt: draft.systemPrompt,
        openingMessage: draft.openingMessage,
        suggestedQuestions,
      }
    )
    setSaving(true)
    try {
      if (editing) {
        if (editingScope === 'global') {
          const updated = await updateGlobalPlaygroundPreset(editing.id, input)
          setGlobalPresets((current) =>
            current.map((item) => (item.id === updated.id ? updated : item))
          )
        } else {
          const updated = await updatePlaygroundPreset(editing.id, input)
          setPresets((current) =>
            current.map((item) => (item.id === updated.id ? updated : item))
          )
        }
      } else if (editingScope === 'global') {
        const created = await createGlobalPlaygroundPreset(input)
        setGlobalPresets((current) => [created, ...current])
        setGlobalTotal((current) => current + 1)
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
      if (deleteTarget.scope === 'global') {
        await deleteGlobalPlaygroundPreset(deleteTarget.preset.id)
        setGlobalPresets((current) =>
          current.filter((item) => item.id !== deleteTarget.preset.id)
        )
        setGlobalTotal((current) => Math.max(0, current - 1))
      } else {
        await deletePlaygroundPreset(deleteTarget.preset.id)
        setPresets((current) =>
          current.filter((item) => item.id !== deleteTarget.preset.id)
        )
        setTotal((current) => Math.max(0, current - 1))
      }
      setDeleteTarget(null)
      toast.success(t('Preset deleted'))
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_PRESET_ERRORS.DELETE_FAILED))
    } finally {
      setDeleting(false)
    }
  }

  const copyPreset = async (preset: AssistantPreset) => {
    try {
      await copyPlaygroundPresetToMine(preset.id)
      toast.success(t('Preset copied to your presets'))
    } catch (error) {
      handleServerError(error, t('Failed to copy preset.'))
    }
  }

  const exportPreset = async (
    preset: AssistantPreset,
    scope: PlaygroundPresetScope
  ) => {
    try {
      await exportPlaygroundPresetFile(preset.id, scope)
      toast.success(t('Preset exported'))
    } catch (error) {
      handleServerError(error, t('Failed to export preset.'))
    }
  }

  const importPreset = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const content = await file.text()
      JSON.parse(content)
      if (tab === 'global') {
        const imported = await importPlaygroundPreset(content, 'global')
        setGlobalPresets((current) => [imported, ...current])
        setGlobalTotal((current) => current + 1)
      } else {
        const imported = await importPlaygroundPreset(content, 'private')
        setPresets((current) => [imported, ...current])
        setTotal((current) => current + 1)
      }
      toast.success(t('Preset imported'))
    } catch (error) {
      handleServerError(error, t('Failed to import preset.'))
    } finally {
      setImporting(false)
      input.value = ''
    }
  }

  const canCreate = limit <= 0 || total < limit
  let editorTitle = editing ? t('Edit preset') : t('New preset')
  if (editingScope === 'global') {
    editorTitle = editing ? t('Edit global preset') : t('New global preset')
  }

  const renderActions = (scope: PresetTab) => {
    const canAddPreset = scope !== 'private' || canCreate
    return (
      <div className='flex justify-end gap-1 border-b px-3 py-2'>
        <input
          accept='.json,application/json'
          aria-label={t('Preset file')}
          className='hidden'
          onChange={(event) => void importPreset(event)}
          ref={fileInputRef}
          type='file'
        />
        <Button
          disabled={props.disabled || importing || !canAddPreset}
          onClick={() => fileInputRef.current?.click()}
          size='sm'
          type='button'
          variant='outline'
        >
          <Upload aria-hidden='true' />
          {t('Import preset')}
        </Button>
        <Button
          disabled={props.disabled || !canAddPreset}
          onClick={() => openCreate(scope === 'global' ? 'global' : 'private')}
          size='sm'
          type='button'
        >
          <Plus aria-hidden='true' />
          {scope === 'global' ? t('New global preset') : t('New preset')}
        </Button>
      </div>
    )
  }

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='flex items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='text-xs font-medium'>{t('Assistant presets')}</span>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {tab === 'private' && limit > 0
            ? t('{{used}} of {{limit}}', { used: total, limit })
            : ''}
        </span>
      </div>

      <Tabs
        className='flex min-h-0 flex-1 flex-col gap-0'
        onValueChange={(value) => setTab(value as PresetTab)}
        value={tab}
      >
        <TabsList
          className={cn(
            'mx-3 mt-2 grid h-8',
            isAdmin ? 'grid-cols-3' : 'grid-cols-2'
          )}
        >
          <TabsTrigger className='text-xs' value='private'>
            {t('My presets')}
          </TabsTrigger>
          <TabsTrigger className='text-xs' value='market'>
            {t('Preset market')}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger className='text-xs' value='global'>
              {t('Global presets')}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent
          className='mt-0 flex min-h-0 flex-1 flex-col'
          value='private'
        >
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
              {renderActions('private')}
            </div>
          )}
          {(status === 'loading' || presets.length > 0) && (
            <>
              {presets.length > 0 && renderActions('private')}
              <ScrollArea className='min-h-0 flex-1'>
                <ul className='grid gap-2 p-3'>
                  {status === 'loading' && (
                    <LoadingState className='min-h-24' />
                  )}
                  {presets.map((preset) => (
                    <PresetCard
                      disabled={props.disabled}
                      key={preset.id}
                      onApply={() => props.onApplyPreset(preset)}
                      onDelete={() =>
                        setDeleteTarget({ preset, scope: 'private' })
                      }
                      onEdit={() => openEdit(preset, 'private')}
                      onExport={() => void exportPreset(preset, 'private')}
                      onStart={() => props.onCreateSession(preset)}
                      preset={preset}
                      scope='private'
                    />
                  ))}
                </ul>
              </ScrollArea>
            </>
          )}
        </TabsContent>

        <TabsContent
          className='mt-0 flex min-h-0 flex-1 flex-col'
          value='market'
        >
          {marketStatus === 'error' && (
            <div className='shrink-0 p-2'>
              <ErrorState
                className='min-h-0 p-2'
                description={getServerMessage(marketError)}
                onRetry={() => setRefreshKey((value) => value + 1)}
                title={t('Failed to load the preset market')}
              />
            </div>
          )}
          {marketStatus === 'ready' && market.length === 0 && (
            <div className='flex min-h-0 flex-1 flex-col items-center justify-center p-4'>
              <EmptyState
                description={t(
                  'Presets published by an administrator will appear here.'
                )}
                title={t('No market presets yet')}
              />
            </div>
          )}
          {(marketStatus === 'loading' || market.length > 0) && (
            <ScrollArea className='min-h-0 flex-1'>
              <ul className='grid gap-2 p-3'>
                {marketStatus === 'loading' && (
                  <LoadingState className='min-h-24' />
                )}
                {market.map((preset) => (
                  <PresetCard
                    disabled={props.disabled}
                    key={preset.id}
                    onApply={() => props.onApplyPreset(preset)}
                    onCopy={() => void copyPreset(preset)}
                    onStart={() => props.onCreateSession(preset)}
                    preset={preset}
                    scope='market'
                  />
                ))}
              </ul>
              {marketStatus === 'ready' && (
                <p className='text-muted-foreground px-3 pb-2 text-xs tabular-nums'>
                  {t('{{count}} market presets', { count: marketTotal })}
                </p>
              )}
            </ScrollArea>
          )}
        </TabsContent>

        {isAdmin && (
          <TabsContent
            className='mt-0 flex min-h-0 flex-1 flex-col'
            value='global'
          >
            {globalStatus === 'error' && (
              <div className='shrink-0 p-2'>
                <ErrorState
                  className='min-h-0 p-2'
                  description={getServerMessage(globalError)}
                  onRetry={() => setRefreshKey((value) => value + 1)}
                  title={t('Failed to load global presets')}
                />
              </div>
            )}
            {globalStatus === 'ready' && globalPresets.length === 0 && (
              <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4'>
                <EmptyState
                  description={t(
                    'Publish a preset to offer it to every account in the preset market.'
                  )}
                  title={t('No global presets yet')}
                />
                {renderActions('global')}
              </div>
            )}
            {(globalStatus === 'loading' || globalPresets.length > 0) && (
              <>
                {globalPresets.length > 0 && renderActions('global')}
                <ScrollArea className='min-h-0 flex-1'>
                  <ul className='grid gap-2 p-3'>
                    {globalStatus === 'loading' && (
                      <LoadingState className='min-h-24' />
                    )}
                    {globalPresets.map((preset) => (
                      <PresetCard
                        disabled={props.disabled}
                        key={preset.id}
                        onApply={() => props.onApplyPreset(preset)}
                        onDelete={() =>
                          setDeleteTarget({ preset, scope: 'global' })
                        }
                        onEdit={() => openEdit(preset, 'global')}
                        onExport={() => void exportPreset(preset, 'global')}
                        onStart={() => props.onCreateSession(preset)}
                        preset={preset}
                        scope='global'
                      />
                    ))}
                  </ul>
                  {globalStatus === 'ready' && (
                    <p className='text-muted-foreground px-3 pb-2 text-xs tabular-nums'>
                      {t('{{count}} global presets', { count: globalTotal })}
                    </p>
                  )}
                </ScrollArea>
              </>
            )}
          </TabsContent>
        )}
      </Tabs>

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
        title={editorTitle}
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
          <div className='grid gap-2'>
            <Label htmlFor='playground-preset-opening'>
              {t('Opening message')}
            </Label>
            <Textarea
              className='min-h-24'
              id='playground-preset-opening'
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  openingMessage: event.target.value,
                }))
              }
              placeholder={t(
                'Shown before the first message. It is never sent to the model.'
              )}
              value={draft.openingMessage}
            />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='playground-preset-questions'>
              {t('Suggested questions')}
            </Label>
            <Textarea
              className='min-h-20'
              id='playground-preset-questions'
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  suggestedQuestions: event.target.value,
                }))
              }
              placeholder={t('One question per line, up to 6.')}
              value={draft.suggestedQuestions}
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
        desc={
          deleteTarget?.scope === 'global'
            ? t(
                'This preset will be removed from the market for every account. Copies already made are kept.'
              )
            : t('This assistant preset will be deleted from your account.')
        }
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
