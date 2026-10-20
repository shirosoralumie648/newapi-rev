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
  ChevronsUpDown,
  Check,
  CpuIcon,
  LayersIcon,
  PlusIcon,
} from 'lucide-react'
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'
import { toIntlLocale } from '@/i18n/languages'
import { formatCompactNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import { formatGroupDetail } from './model-group-selector/group-detail'
import {
  modelGroupSelectorLayoutClasses,
  scrollSelectedOptionIntoView,
} from './model-group-selector/layout'

interface ModelOption {
  label: string
  value: string
  category?: string
  /** Description of the curated catalog section named by `category`. */
  categoryDescription?: string
  /** Emoji or HTTP(S) image URL supplied by the administrator catalog. */
  icon?: string
  description?: string
  /** Preformatted price summary shown under the model name. */
  priceLabel?: string
  /** Context window in tokens, shown beside the price. */
  contextLength?: number
  /** Recommended output ceiling in tokens, shown beside the context window. */
  maxOutputTokens?: number
  /** Already translated capability tags shown beside the price. */
  capabilityLabels?: string[]
}

interface GroupOption {
  label: string
  value: string
  ratio?: number | string
  desc?: string
  description?: string
}

interface ModelSelectorProps {
  selectedModel: string
  models: ModelOption[]
  onModelChange: (value: string) => void
  className?: string
  disabled?: boolean
}

interface GroupSelectorProps {
  selectedGroup: string
  groups: GroupOption[]
  onGroupChange: (value: string) => void
  className?: string
  disabled?: boolean
}

const ModelTriggerButton = React.forwardRef<
  React.ComponentRef<typeof Button>,
  React.ComponentPropsWithoutRef<typeof Button> & {
    currentLabel: string
    triggerClassName?: string
    isDisabled?: boolean
  }
>(({ currentLabel, triggerClassName, isDisabled, ...props }, ref) => (
  <Button
    ref={ref}
    variant='outline'
    role='combobox'
    size='sm'
    disabled={isDisabled}
    className={cn(
      'flex h-8 items-center gap-2 border px-3 font-medium',
      'justify-center p-0 sm:w-auto sm:justify-start sm:px-3',
      'w-8',
      'bg-background text-foreground',
      'hover:bg-accent transition-colors',
      'focus:!ring-0 focus:!outline-none',
      'shadow-none',
      triggerClassName
    )}
    {...props}
  >
    <CpuIcon className='text-muted-foreground block size-4 sm:hidden' />
    <span className='text-muted-foreground sm:text-foreground hidden truncate text-xs sm:block'>
      {currentLabel}
    </span>
    <ChevronsUpDown className='text-muted-foreground hidden h-4 w-4 opacity-50 sm:block' />
  </Button>
))

ModelTriggerButton.displayName = 'ModelTriggerButton'

const GroupTriggerButton = React.forwardRef<
  React.ComponentRef<typeof Button>,
  React.ComponentPropsWithoutRef<typeof Button> & {
    currentLabel: string
    triggerClassName?: string
    isDisabled?: boolean
  }
>(({ currentLabel, triggerClassName, isDisabled, ...props }, ref) => (
  <Button
    ref={ref}
    variant='outline'
    role='combobox'
    size='sm'
    disabled={isDisabled}
    className={cn(
      'flex h-8 items-center gap-2 border px-3 font-medium',
      'justify-center p-0 sm:w-auto sm:justify-start sm:px-3',
      'w-8',
      'bg-background text-foreground',
      'hover:bg-accent transition-colors',
      'focus:!ring-0 focus:!outline-none',
      'shadow-none',
      triggerClassName
    )}
    {...props}
  >
    <LayersIcon className='text-muted-foreground block size-4 sm:hidden' />
    <span className='text-muted-foreground sm:text-foreground hidden truncate text-xs sm:block'>
      {currentLabel}
    </span>
    <ChevronsUpDown className='text-muted-foreground hidden h-4 w-4 opacity-50 sm:block' />
  </Button>
))

GroupTriggerButton.displayName = 'GroupTriggerButton'

/**
 * Model Selector Component
 * Styled following Scira's form-component design patterns
 */
export const ModelSelector: React.FC<ModelSelectorProps> = React.memo(
  ({ selectedModel, models, onModelChange, className, disabled = false }) => {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const isMobile = useIsMobile()

    const currentModel = useMemo(
      () => models.find((m) => m.value === selectedModel),
      [models, selectedModel]
    )

    // Group models by category
    const groupedModels = useMemo(
      () =>
        models.reduce(
          (acc, model) => {
            const category = model.category || t('Other')
            if (!acc[category]) {
              acc[category] = []
            }
            acc[category].push(model)
            return acc
          },
          {} as Record<string, ModelOption[]>
        ),
      [models, t]
    )

    // Filter models by search query
    const filteredModels = useMemo(() => {
      if (!searchQuery.trim()) return groupedModels

      const query = searchQuery.toLowerCase()
      const filtered: Record<string, ModelOption[]> = {}

      Object.entries(groupedModels).forEach(([category, categoryModels]) => {
        const matches = categoryModels.filter(
          (m) =>
            m.label.toLowerCase().includes(query) ||
            m.value.toLowerCase().includes(query) ||
            m.description?.toLowerCase().includes(query)
        )
        if (matches.length > 0) {
          filtered[category] = matches
        }
      })

      return filtered
    }, [groupedModels, searchQuery])

    const handleModelChange = useCallback(
      (value: string) => {
        onModelChange(value)
        setOpen(false)
        setSearchQuery('')
      },
      [onModelChange]
    )

    // Shared command content
    const renderModelCommandContent = () => (
      <Command
        className={cn(
          isMobile
            ? 'h-full flex-1 rounded-lg border-0 bg-transparent'
            : 'rounded-lg'
        )}
        filter={() => 1}
        shouldFilter={false}
      >
        {!isMobile && (
          <CommandInput
            placeholder={t('Search models...')}
            className='h-9'
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
        )}
        <CommandEmpty>{t('No model found.')}</CommandEmpty>
        <CommandList
          className={isMobile ? '!max-h-full flex-1 p-2' : 'max-h-[300px]'}
        >
          {Object.keys(filteredModels).length === 0 ? (
            <div className='text-muted-foreground px-3 py-6 text-xs'>
              {t('No model found.')}
            </div>
          ) : (
            Object.entries(filteredModels).map(
              ([category, categoryModels], categoryIndex) => (
                <CommandGroup key={category}>
                  {categoryIndex > 0 && (
                    <div className='border-border my-1 border-t' />
                  )}
                  <div
                    className={cn(
                      'text-muted-foreground px-2 py-1 font-medium',
                      isMobile ? 'text-xs' : 'text-[10px]'
                    )}
                  >
                    {t('{{category}} Models', { category })}
                  </div>
                  {categoryModels.map((model) => (
                    <CommandItem
                      key={model.value}
                      value={model.value}
                      onSelect={handleModelChange}
                      className={cn(
                        'mb-0.5 flex items-center justify-between rounded-lg px-2 py-1.5 text-xs',
                        'transition-all duration-200',
                        'hover:bg-accent',
                        'data-[selected=true]:bg-accent'
                      )}
                    >
                      <div className='flex min-w-0 flex-1 items-center gap-1'>
                        <div
                          className={cn(
                            'truncate font-medium',
                            isMobile ? 'text-sm' : 'text-[11px]'
                          )}
                        >
                          <span className='inline'>{model.label}</span>
                        </div>
                        <Check
                          className={cn(
                            'h-4 w-4 flex-shrink-0',
                            selectedModel === model.value
                              ? 'opacity-100'
                              : 'opacity-0'
                          )}
                        />
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            )
          )}
        </CommandList>
      </Command>
    )

    return isMobile ? (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <ModelTriggerButton
            currentLabel={currentModel?.label || t('Model')}
            triggerClassName={className}
            isDisabled={disabled}
            aria-expanded={open}
          />
        </DrawerTrigger>
        <DrawerContent className='flex max-h-[80vh] min-h-[60vh] flex-col'>
          <DrawerHeader className='flex-shrink-0 pb-4'>
            <DrawerTitle className='flex items-center gap-2 text-left text-lg font-medium'>
              {t('Select Model')}
            </DrawerTitle>
          </DrawerHeader>
          <div className='flex min-h-0 flex-1 flex-col'>
            {renderModelCommandContent()}
          </div>
        </DrawerContent>
      </Drawer>
    ) : (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <ModelTriggerButton
              currentLabel={currentModel?.label || t('Model')}
              triggerClassName={className}
              isDisabled={disabled}
              aria-expanded={open}
            />
          }
        />
        <PopoverContent
          className='bg-popover z-40 w-[90vw] max-w-[20em] rounded-lg border p-0 !shadow-none sm:w-[20em]'
          align='start'
          side='bottom'
          sideOffset={4}
          collisionPadding={8}
        >
          {renderModelCommandContent()}
        </PopoverContent>
      </Popover>
    )
  }
)

ModelSelector.displayName = 'ModelSelector'

/**
 * Group Selector Component
 * Styled following Scira's form-component design patterns
 */
export const GroupSelector: React.FC<GroupSelectorProps> = React.memo(
  ({ selectedGroup, groups, onGroupChange, className, disabled = false }) => {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const isMobile = useIsMobile()

    const currentGroup = useMemo(
      () => groups.find((g) => g.value === selectedGroup),
      [groups, selectedGroup]
    )

    const handleGroupChange = useCallback(
      (value: string) => {
        onGroupChange(value)
        setOpen(false)
      },
      [onGroupChange]
    )

    // Shared command content
    const renderGroupCommandContent = () => (
      <Command
        className={cn(
          isMobile
            ? 'h-full flex-1 rounded-lg border-0 bg-transparent'
            : 'rounded-lg'
        )}
        filter={(value, search) => {
          const group = groups.find((g) => g.value === value)
          if (!group || !search) return 1

          const searchTerm = search.toLowerCase()
          const searchableFields = [
            group.label,
            group.description || '',
            group.value,
          ]
            .join(' ')
            .toLowerCase()

          return searchableFields.includes(searchTerm) ? 1 : 0
        }}
      >
        <CommandInput placeholder={t('Search groups...')} className='h-9' />
        <CommandEmpty>{t('No group found.')}</CommandEmpty>
        <CommandList
          className={isMobile ? '!max-h-full flex-1 p-2' : 'max-h-[240px]'}
        >
          <CommandGroup>
            <div className='text-muted-foreground px-2 py-1 text-[10px] font-medium'>
              {t('Model Group')}
            </div>
            {groups.map((group) => (
              <CommandItem
                key={group.value}
                value={group.value}
                onSelect={handleGroupChange}
                className={cn(
                  'mb-0.5 flex items-center justify-between rounded-lg px-2 py-2 text-xs',
                  'transition-all duration-200',
                  'hover:bg-accent',
                  'data-[selected=true]:bg-accent'
                )}
              >
                <div className='flex min-w-0 flex-1 items-center gap-2 pr-4'>
                  <div className='flex min-w-0 flex-1 flex-col'>
                    <span className='text-foreground truncate text-[11px] font-medium'>
                      {group.label}
                    </span>
                    {(group.desc || group.description) && (
                      <div className='text-muted-foreground truncate text-[9px] leading-tight'>
                        {formatGroupDetail(group, t)}
                      </div>
                    )}
                  </div>
                </div>
                <Check
                  className={cn(
                    'ml-auto h-4 w-4',
                    selectedGroup === group.value ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    )

    return isMobile ? (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <GroupTriggerButton
            currentLabel={currentGroup?.label || t('Group')}
            triggerClassName={className}
            isDisabled={disabled}
            aria-expanded={open}
          />
        </DrawerTrigger>
        <DrawerContent className='max-h-[80vh]'>
          <DrawerHeader className='pb-4 text-left'>
            <DrawerTitle>{t('Choose Group')}</DrawerTitle>
          </DrawerHeader>
          <div className='max-h-[calc(80vh-100px)] overflow-y-auto px-4 pb-6'>
            <div className='space-y-2'>
              {groups.map((group) => (
                <Button
                  key={group.value}
                  variant='outline'
                  onClick={() => handleGroupChange(group.value)}
                  className={cn(
                    'flex h-auto w-full items-center justify-between rounded-lg p-4 text-left whitespace-normal',
                    'border-border hover:bg-accent',
                    selectedGroup === group.value
                      ? 'bg-accent border-primary/20'
                      : 'bg-background'
                  )}
                >
                  <div className='flex min-w-0 flex-1 items-center gap-3'>
                    <div className='flex min-w-0 flex-1 flex-col'>
                      <span className='text-foreground text-sm font-medium'>
                        {group.label}
                      </span>
                      {(group.desc || group.description) && (
                        <div className='text-muted-foreground mt-0.5 text-xs'>
                          {formatGroupDetail(group, t)}
                        </div>
                      )}
                    </div>
                  </div>
                  <Check
                    className={cn(
                      'ml-3 h-5 w-5 shrink-0',
                      selectedGroup === group.value
                        ? 'opacity-100'
                        : 'opacity-0'
                    )}
                  />
                </Button>
              ))}
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    ) : (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <GroupTriggerButton
              currentLabel={currentGroup?.label || t('Group')}
              triggerClassName={className}
              isDisabled={disabled}
              aria-expanded={open}
            />
          }
        />
        <PopoverContent
          className='bg-popover z-50 w-[90vw] max-w-[14em] rounded-lg border p-0 !shadow-none sm:w-[14em]'
          align='start'
          side='bottom'
          sideOffset={4}
          collisionPadding={8}
        >
          {renderGroupCommandContent()}
        </PopoverContent>
      </Popover>
    )
  }
)

GroupSelector.displayName = 'GroupSelector'

// Export combined selector component
export interface ModelGroupSelectorProps {
  // Model props
  selectedModel: string
  models: ModelOption[]
  onModelChange: (value: string) => void
  /** Starts a new conversation with the chosen model; omitted hides the action. */
  onStartNewSession?: (model: string) => void
  // Group props
  selectedGroup: string
  groups: GroupOption[]
  onGroupChange: (value: string) => void
  // Common props
  className?: string
  disabled?: boolean
  /** Controlled open state; omit to keep the selector's own state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * Combined Model and Group Selector Component
 * Provides both model and group selection in a unified interface
 */
export const ModelGroupSelector: React.FC<ModelGroupSelectorProps> = ({
  selectedModel,
  models,
  onModelChange,
  onStartNewSession,
  selectedGroup,
  groups,
  onGroupChange,
  className,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}) => {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [internalOpen, setInternalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const isMobile = useIsMobile()
  const open = controlledOpen ?? internalOpen
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen)
      onOpenChange?.(nextOpen)
    },
    [controlledOpen, onOpenChange]
  )
  const groupScrollContainerRef = useRef<HTMLDivElement | null>(null)
  const selectedGroupOptionRef = useRef<HTMLButtonElement | null>(null)
  const selectedModelOptionRef = useRef<HTMLDivElement | null>(null)

  const currentModel = useMemo(
    () => models.find((model) => model.value === selectedModel),
    [models, selectedModel]
  )
  const currentGroup = useMemo(
    () => groups.find((group) => group.value === selectedGroup),
    [groups, selectedGroup]
  )
  const filteredModels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) {
      return models
    }

    return models.filter((model) => {
      const searchableText = [
        model.label,
        model.value,
        model.description || '',
        model.category || '',
      ]
        .join(' ')
        .toLowerCase()

      return searchableText.includes(query)
    })
  }, [models, searchQuery])

  // Catalog sections are optional: a deployment without them keeps the
  // original flat list and never shows an empty "Other" header.
  const categoryGroups = useMemo(() => {
    if (!filteredModels.some((model) => model.category)) return null
    const groups = new Map<
      string,
      { label: string; description?: string; models: ModelOption[] }
    >()
    for (const model of filteredModels) {
      const label = model.category?.trim() || t('Other')
      const existing = groups.get(label)
      if (existing) {
        existing.models.push(model)
        continue
      }
      groups.set(label, {
        label,
        description: model.categoryDescription,
        models: [model],
      })
    }
    return [...groups.values()]
  }, [filteredModels, t])

  const handleModelChange = useCallback(
    (value: string) => {
      onModelChange(value)
      setOpen(false)
      setSearchQuery('')
    },
    [onModelChange, setOpen]
  )

  const handleGroupChange = useCallback(
    (value: string) => {
      onGroupChange(value)
    },
    [onGroupChange]
  )

  useEffect(() => {
    if (!open) {
      return
    }

    let secondFrameId = 0
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        scrollSelectedOptionIntoView(
          selectedGroupOptionRef.current,
          groupScrollContainerRef.current
        )
        scrollSelectedOptionIntoView(selectedModelOptionRef.current)
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrameId)
      window.cancelAnimationFrame(secondFrameId)
    }
  }, [open, selectedGroup, selectedModel])

  const renderTrigger = () => (
    <Button
      aria-expanded={open}
      className={cn(
        'h-8 max-w-[15rem] justify-start gap-2 border px-2.5 font-medium shadow-none',
        'bg-background/80 hover:bg-accent/70 text-foreground',
        'focus:!ring-0 focus:!outline-none',
        className
      )}
      disabled={disabled}
      role='combobox'
      size='sm'
      variant='outline'
    >
      <CpuIcon className='text-muted-foreground size-4 shrink-0' />
      <span className='min-w-0 truncate text-xs'>
        {currentModel?.label || t('Model')}
      </span>
      <span className='bg-muted text-muted-foreground hidden max-w-20 shrink-0 rounded px-1.5 py-0.5 text-[10px] sm:inline-flex'>
        {currentGroup?.label || t('Group')}
      </span>
      <ChevronsUpDown className='text-muted-foreground ml-auto size-3.5 shrink-0 opacity-60' />
    </Button>
  )

  const renderGroupList = () => (
    <div
      className={cn(
        'min-w-0 space-y-2',
        !isMobile && modelGroupSelectorLayoutClasses.groupColumn
      )}
    >
      <div className='text-muted-foreground px-1 text-[11px] leading-4 font-medium'>
        {t('Model Group')}
      </div>
      <div
        className={cn(
          'grid gap-1',
          !isMobile && modelGroupSelectorLayoutClasses.groupScroll
        )}
        ref={groupScrollContainerRef}
      >
        {groups.map((group) => {
          const isSelected = selectedGroup === group.value

          return (
            <button
              className={cn(
                'flex min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-[12px] leading-4 transition-colors',
                isSelected
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              disabled={disabled}
              key={group.value}
              onClick={() => handleGroupChange(group.value)}
              ref={isSelected ? selectedGroupOptionRef : undefined}
              type='button'
            >
              <span className='min-w-0 truncate font-medium'>
                {group.label}
              </span>
              <Check
                className={cn(
                  'size-3.5 shrink-0',
                  isSelected ? 'opacity-100' : 'opacity-0'
                )}
              />
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderModelItem = (model: ModelOption) => {
    const contextLength = model.contextLength ?? 0
    const maxOutputTokens = model.maxOutputTokens ?? 0
    const hasMeta = Boolean(
      model.priceLabel ||
      contextLength > 0 ||
      maxOutputTokens > 0 ||
      model.capabilityLabels?.length
    )
    return (
      <CommandItem
        className={cn(
          modelGroupSelectorLayoutClasses.modelItem,
          hasMeta && 'items-start',
          selectedModel === model.value
            ? modelGroupSelectorLayoutClasses.selectedModelItem
            : modelGroupSelectorLayoutClasses.unselectedModelItem
        )}
        key={model.value}
        onSelect={handleModelChange}
        ref={selectedModel === model.value ? selectedModelOptionRef : undefined}
        value={model.value}
      >
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              selectedModel === model.value
                ? modelGroupSelectorLayoutClasses.selectedModelText
                : modelGroupSelectorLayoutClasses.unselectedModelText
            )}
          >
            {model.icon &&
              (/^https?:\/\//i.test(model.icon) ? (
                <img
                  alt=''
                  className='size-4 shrink-0 rounded-sm object-cover'
                  loading='lazy'
                  src={model.icon}
                />
              ) : (
                <span
                  aria-hidden='true'
                  className='shrink-0 text-sm leading-none'
                >
                  {model.icon}
                </span>
              ))}
            <span className='truncate'>{model.label}</span>
          </span>
          {model.description && (
            <span className='text-muted-foreground truncate text-[10px] leading-4'>
              {model.description}
            </span>
          )}
          {hasMeta && (
            <span className='text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-4'>
              {model.priceLabel && (
                <span className='truncate'>{model.priceLabel}</span>
              )}
              {contextLength > 0 && (
                <span className='shrink-0'>
                  {t('{{tokens}} context', {
                    tokens: formatCompactNumber(contextLength, locale),
                  })}
                </span>
              )}
              {maxOutputTokens > 0 && (
                <span className='shrink-0'>
                  {t('{{tokens}} max output', {
                    tokens: formatCompactNumber(maxOutputTokens, locale),
                  })}
                </span>
              )}
              {model.capabilityLabels?.map((capability) => (
                <span
                  className='bg-muted shrink-0 rounded px-1 py-px'
                  key={capability}
                >
                  {capability}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className='ml-1 flex shrink-0 items-center gap-0.5'>
          {onStartNewSession && (
            <Button
              aria-label={t('Start a new session with this model')}
              className='text-muted-foreground hover:text-foreground size-6'
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setOpen(false)
                setSearchQuery('')
                onStartNewSession(model.value)
              }}
              onPointerDown={(event) => event.stopPropagation()}
              size='icon-sm'
              title={t('Start a new session with this model')}
              type='button'
              variant='ghost'
            >
              <PlusIcon className='size-3.5' />
            </Button>
          )}
          <Check
            className={cn(
              'size-3.5 shrink-0',
              selectedModel === model.value ? 'opacity-100' : 'opacity-0',
              hasMeta && 'mt-0.5'
            )}
          />
        </div>
      </CommandItem>
    )
  }

  const renderModelList = () => (
    <Command
      className={cn(
        'min-w-0 rounded-lg border-0 bg-transparent p-1',
        !isMobile && modelGroupSelectorLayoutClasses.modelCommand
      )}
      filter={() => 1}
      shouldFilter={false}
    >
      <CommandInput
        className='h-8 text-[13px]'
        onValueChange={setSearchQuery}
        placeholder={t('Search models...')}
        value={searchQuery}
      />
      <CommandList
        className={
          isMobile ? 'max-h-[45vh]' : modelGroupSelectorLayoutClasses.modelList
        }
      >
        {filteredModels.length === 0 ? (
          <div className='text-muted-foreground px-3 py-8 text-center text-[12px] leading-5'>
            {t('No model found.')}
          </div>
        ) : categoryGroups ? (
          categoryGroups.map((group, index) => (
            <CommandGroup className='p-1' key={group.label}>
              <div
                className={cn(
                  'px-2 pb-1',
                  index > 0 && 'border-border mt-2 border-t pt-2'
                )}
              >
                <div className='text-muted-foreground text-[10px] leading-4 font-medium'>
                  {group.label}
                </div>
                {group.description && (
                  <div className='text-muted-foreground/80 truncate text-[9px] leading-4'>
                    {group.description}
                  </div>
                )}
              </div>
              {group.models.map(renderModelItem)}
            </CommandGroup>
          ))
        ) : (
          <CommandGroup className='p-1'>
            {filteredModels.map(renderModelItem)}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )

  const renderContent = () => (
    <div
      className={
        isMobile
          ? 'grid gap-3 p-2 md:grid-cols-[9.5rem_minmax(0,1fr)]'
          : modelGroupSelectorLayoutClasses.desktopContent
      }
    >
      {renderGroupList()}
      <div
        className={cn(
          'min-w-0 overflow-hidden rounded-lg border',
          !isMobile && modelGroupSelectorLayoutClasses.modelColumn
        )}
      >
        {renderModelList()}
      </div>
    </div>
  )

  return isMobile ? (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>{renderTrigger()}</DrawerTrigger>
      <DrawerContent className='flex max-h-[80vh] min-h-[60vh] flex-col'>
        <DrawerHeader className='pb-3 text-left'>
          <DrawerTitle>{t('Select Model')}</DrawerTitle>
        </DrawerHeader>
        <div className='min-h-0 flex-1 overflow-y-auto px-4 pb-5'>
          {renderContent()}
        </div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={renderTrigger()} />
      <PopoverContent
        align='end'
        className={cn(
          'bg-popover z-50 w-[34rem] max-w-[calc(100vw-2rem)] rounded-xl border p-0 shadow-lg',
          modelGroupSelectorLayoutClasses.desktopPanel
        )}
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        {renderContent()}
      </PopoverContent>
    </Popover>
  )
}
