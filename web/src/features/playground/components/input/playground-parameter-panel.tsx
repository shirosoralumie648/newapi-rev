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
import { SlidersHorizontalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

import {
  getParameterControlValueText,
  normalizeParameterNumberValue,
  PLAYGROUND_PARAMETER_CONTROLS,
  PLAYGROUND_PARAMETER_PANEL_SCROLL_CLASS,
  type PlaygroundParameterKey,
} from '../../lib/parameters/playground-parameters'
import {
  getReasoningEffortLabelKey,
  modelSupportsReasoningEffort,
  normalizeReasoningEffort,
  PLAYGROUND_REASONING_EFFORT_OPTIONS,
} from '../../lib/parameters/playground-reasoning'
import type { ParameterEnabled, PlaygroundConfig } from '../../types'

type PlaygroundParameterPanelProps = {
  config: PlaygroundConfig
  disabled?: boolean
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onParameterEnabledChange: (
    key: PlaygroundParameterKey,
    value: boolean
  ) => void
  parameterEnabled: ParameterEnabled
  /** Controlled open state, so an empty-state entry can reveal the controls. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

type PlaygroundParameterContentProps = PlaygroundParameterPanelProps & {
  compact?: boolean
}

/**
 * The parameter controls shared by the composer panel and the assistant preset
 * editor. It owns no state: callers pass the draft configuration and receive
 * every change, so a preset editor can reuse the exact same controls.
 */
export function PlaygroundParameterContent({
  compact = false,
  config,
  disabled,
  onConfigChange,
  onParameterEnabledChange,
  parameterEnabled,
}: PlaygroundParameterContentProps) {
  const { t } = useTranslation()

  const updateParameterConfig = (
    key: PlaygroundParameterKey,
    value: number | null
  ) => {
    if (key === 'seed') {
      onConfigChange('seed', value)
      return
    }

    onConfigChange(key, value ?? 0)
  }

  const reasoningSupported = modelSupportsReasoningEffort(config.model)
  const reasoningEffort = normalizeReasoningEffort(config.reasoning_effort)
  const reasoningItems = PLAYGROUND_REASONING_EFFORT_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }))

  return (
    <div
      className={cn(
        'grid gap-3',
        PLAYGROUND_PARAMETER_PANEL_SCROLL_CLASS,
        compact ? 'px-4 pb-4' : 'p-1'
      )}
    >
      {PLAYGROUND_PARAMETER_CONTROLS.map((control) => {
        const enabled = parameterEnabled[control.key]
        const value = config[control.key]
        const controlId = `playground-${control.key}`

        return (
          <div
            className={cn(
              'border-border/70 bg-background/60 grid gap-2 rounded-lg border p-3 transition-opacity',
              (!enabled || disabled) && 'opacity-55'
            )}
            key={control.key}
          >
            <div className='flex items-start justify-between gap-3'>
              <div className='min-w-0 space-y-1'>
                <div className='flex min-w-0 items-center gap-2'>
                  <label
                    className='truncate text-sm leading-5 font-medium'
                    htmlFor={controlId}
                  >
                    {t(control.labelKey)}
                  </label>
                  <Badge
                    className='h-5 max-w-24 shrink-0 px-1.5 font-mono text-[11px]'
                    variant='outline'
                  >
                    {t(getParameterControlValueText(control.key, value))}
                  </Badge>
                </div>
                <p className='text-muted-foreground text-xs leading-4'>
                  {t(control.descriptionKey)}
                </p>
              </div>

              <Switch
                aria-label={t('Enable {{parameter}}', {
                  parameter: t(control.labelKey),
                })}
                checked={enabled}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onParameterEnabledChange(control.key, checked)
                }
                size='sm'
              />
            </div>

            {control.valueType === 'slider' ? (
              <Slider
                className='py-1.5'
                disabled={disabled || !enabled}
                id={controlId}
                max={control.max}
                min={control.min}
                onValueChange={(nextValue) => {
                  const firstValue = Array.isArray(nextValue)
                    ? nextValue[0]
                    : nextValue
                  updateParameterConfig(
                    control.key,
                    normalizeParameterNumberValue(control.key, firstValue)
                  )
                }}
                step={control.step}
                value={[Number(value)]}
              />
            ) : (
              <Input
                disabled={disabled || !enabled}
                id={controlId}
                inputMode='numeric'
                max={control.max}
                min={control.min}
                onChange={(event) => {
                  updateParameterConfig(
                    control.key,
                    normalizeParameterNumberValue(
                      control.key,
                      event.target.value
                    )
                  )
                }}
                step={control.step}
                type='number'
                value={value ?? ''}
              />
            )}
          </div>
        )
      })}

      {reasoningSupported ? (
        <div
          className={cn(
            'border-border/70 bg-background/60 grid gap-2 rounded-lg border p-3 transition-opacity',
            (!parameterEnabled.reasoning_effort || disabled) && 'opacity-55'
          )}
        >
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0 space-y-1'>
              <div className='flex min-w-0 items-center gap-2'>
                <label
                  className='truncate text-sm leading-5 font-medium'
                  htmlFor='playground-reasoning_effort'
                >
                  {t('Reasoning Effort')}
                </label>
                <Badge
                  className='h-5 max-w-24 shrink-0 px-1.5 font-mono text-[11px]'
                  variant='outline'
                >
                  {t(getReasoningEffortLabelKey(reasoningEffort) ?? 'Not set')}
                </Badge>
              </div>
              <p className='text-muted-foreground text-xs leading-4'>
                {t('How much the model should reason before answering')}
              </p>
            </div>

            <Switch
              aria-label={t('Enable {{parameter}}', {
                parameter: t('Reasoning Effort'),
              })}
              checked={parameterEnabled.reasoning_effort}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onParameterEnabledChange('reasoning_effort', checked)
              }
              size='sm'
            />
          </div>

          <Select
            disabled={disabled || !parameterEnabled.reasoning_effort}
            items={reasoningItems}
            onValueChange={(value: unknown) => {
              if (typeof value !== 'string') return
              onConfigChange('reasoning_effort', value)
            }}
            value={reasoningEffort || null}
          >
            <SelectTrigger
              className='w-full'
              id='playground-reasoning_effort'
              size='sm'
            >
              <SelectValue placeholder={t('Select a reasoning effort')} />
            </SelectTrigger>
            <SelectContent>
              {PLAYGROUND_REASONING_EFFORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  )
}

export function PlaygroundParameterPanel(props: PlaygroundParameterPanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const activeCount =
    PLAYGROUND_PARAMETER_CONTROLS.filter(
      (control) => props.parameterEnabled[control.key]
    ).length +
    (modelSupportsReasoningEffort(props.config.model) &&
    props.parameterEnabled.reasoning_effort
      ? 1
      : 0)

  const trigger = (
    <PromptInputButton
      aria-label={t('Parameters')}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 relative font-medium'
      data-tour='composer-parameters'
      disabled={props.disabled}
      variant='ghost'
    >
      <SlidersHorizontalIcon size={16} />
      <span className='bg-primary text-primary-foreground absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-semibold'>
        {activeCount}
      </span>
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={props.onOpenChange} open={props.open}>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Parameters')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Parameter settings')}</SheetTitle>
          </SheetHeader>
          <PlaygroundParameterContent {...props} compact />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover onOpenChange={props.onOpenChange} open={props.open}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Parameters')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='w-[22rem] max-w-[calc(100vw-2rem)] gap-3 p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        <div className='space-y-1 px-1'>
          <div className='text-sm font-semibold'>{t('Parameter settings')}</div>
          <div className='text-muted-foreground text-xs leading-4'>
            {t('Only enabled parameters are sent with the request.')}
          </div>
        </div>
        <PlaygroundParameterContent {...props} />
      </PopoverContent>
    </Popover>
  )
}
