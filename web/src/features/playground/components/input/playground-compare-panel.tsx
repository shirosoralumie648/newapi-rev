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
import { Columns3Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { MultiSelect } from '@/components/multi-select'
import { Label } from '@/components/ui/label'
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
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

import {
  PLAYGROUND_PARALLEL_MAX_MODELS,
  PLAYGROUND_PARALLEL_MESSAGES,
  PLAYGROUND_PARALLEL_MIN_MODELS,
} from '../../constants'
import { isChatModelOption, normalizeParallelModels } from '../../lib'
import type { ModelOption } from '../../types'

type PlaygroundComparePanelProps = {
  disabled?: boolean
  models: ModelOption[]
  onCompareModelsChange: (models: string[]) => void
  compareModels: string[]
  /** The next comparison hides model names and records a raw preference. */
  anonymous: boolean
  onAnonymousChange: (anonymous: boolean) => void
}

type PlaygroundCompareContentProps = PlaygroundComparePanelProps

/**
 * Model multi-selection of one parallel comparison. Selecting two or more
 * models turns the composer's next send into a comparison: the same message
 * goes to every selected model as its own `/pg` request, so each reply is
 * billed, grouped and rate limited by the ordinary relay pipeline. The parent
 * bounds the selection; the server enforces the owner's policy when the
 * message group is stored.
 */
export function PlaygroundCompareContent(props: PlaygroundCompareContentProps) {
  const { t } = useTranslation()
  const selectedCount = props.compareModels.length
  const chatModels = props.models.filter(isChatModelOption)

  const handleSelectedChange = (values: string[]) => {
    if (values.length > PLAYGROUND_PARALLEL_MAX_MODELS) {
      toast.warning(
        t(PLAYGROUND_PARALLEL_MESSAGES.LIMIT, {
          count: PLAYGROUND_PARALLEL_MAX_MODELS,
        })
      )
      return
    }
    props.onCompareModelsChange(normalizeParallelModels(values))
  }

  const handleAnonymousChange = (anonymous: boolean) => {
    // The arena compares exactly two replies. Enabling it while more models
    // are selected trims the selection instead of silently sending a named
    // comparison the reader expects to be anonymous.
    if (anonymous && props.compareModels.length > 2) {
      props.onCompareModelsChange(props.compareModels.slice(0, 2))
    }
    props.onAnonymousChange(anonymous)
  }

  return (
    <div className='grid gap-2 p-1'>
      <MultiSelect
        allowCreate={false}
        className='w-full'
        disabled={props.disabled}
        id='playground-compare-models'
        maxVisibleChips={2}
        onChange={handleSelectedChange}
        options={chatModels.map((model) => ({
          label: model.label,
          value: model.value,
        }))}
        placeholder={t('Models to compare')}
        selected={props.compareModels}
      />
      <p className='text-muted-foreground text-xs leading-4'>
        {selectedCount >= PLAYGROUND_PARALLEL_MIN_MODELS
          ? t(PLAYGROUND_PARALLEL_MESSAGES.SENDING)
          : t(PLAYGROUND_PARALLEL_MESSAGES.SELECT_MODELS)}
      </p>
      <div className='border-border/60 flex items-start justify-between gap-3 border-t pt-2'>
        <div className='min-w-0'>
          <Label htmlFor='playground-anonymous-arena'>
            {t('Anonymous A/B arena')}
          </Label>
          <p className='text-muted-foreground mt-1 text-xs leading-4'>
            {t(
              'Hide model names and channels for exactly two replies, then vote which one is better. This only stores your raw preference; no ranking is computed.'
            )}
          </p>
          {props.anonymous && selectedCount !== 2 ? (
            <p
              className='text-xs leading-4 text-amber-600 dark:text-amber-400'
              role='alert'
            >
              {t('Select exactly two models for the anonymous arena.')}
            </p>
          ) : null}
        </div>
        <Switch
          checked={props.anonymous}
          disabled={props.disabled}
          id='playground-anonymous-arena'
          onCheckedChange={handleAnonymousChange}
          size='sm'
        />
      </div>
    </div>
  )
}

export function PlaygroundComparePanel(props: PlaygroundComparePanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const selectedCount = props.compareModels.length
  const panelDisabled =
    props.disabled ||
    props.models.filter(isChatModelOption).length <
      PLAYGROUND_PARALLEL_MIN_MODELS

  const trigger = (
    <PromptInputButton
      aria-label={t('Compare models')}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 relative font-medium'
      disabled={panelDisabled}
      variant='ghost'
    >
      <Columns3Icon size={16} />
      {selectedCount > 0 ? (
        <span className='bg-primary text-primary-foreground absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] leading-none font-semibold'>
          {selectedCount}
        </span>
      ) : null}
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Compare models')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Compare models')}</SheetTitle>
          </SheetHeader>
          <PlaygroundCompareContent {...props} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Compare models')}</p>
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
          <div className='text-sm font-semibold'>{t('Compare models')}</div>
          <div className='text-muted-foreground text-xs leading-4'>
            {t(
              'Select at least two models to compare. Each reply is sent and billed as its own request.'
            )}
          </div>
        </div>
        <PlaygroundCompareContent {...props} />
      </PopoverContent>
    </Popover>
  )
}
