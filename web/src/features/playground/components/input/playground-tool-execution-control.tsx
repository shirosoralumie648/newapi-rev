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
import { Wrench } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
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
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

import {
  PLAYGROUND_TOOL_EXECUTION_MAX_ROUNDS,
  PLAYGROUND_TOOL_EXECUTION_MIN_ROUNDS,
} from '../../constants'

type PlaygroundToolExecutionControlProps = {
  disabled?: boolean
  enabled: boolean
  maxRounds: number
  onEnabledChange: (value: boolean) => void
  onMaxRoundsChange: (value: number) => void
}

function PlaygroundToolExecutionContent(
  props: PlaygroundToolExecutionControlProps
) {
  const { t } = useTranslation()

  return (
    <div className='grid gap-3 px-1 pb-1'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <p className='text-sm leading-5 font-medium'>
            {t('Run supported tool calls automatically')}
          </p>
          <p className='text-muted-foreground text-xs leading-4'>
            {t(
              'Web search, current time and knowledge base calls are answered without pasting a result.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t('Run supported tool calls automatically')}
          checked={props.enabled}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onEnabledChange(checked)}
          size='sm'
        />
      </div>

      <div className='border-border/70 flex items-start justify-between gap-3 border-t pt-3'>
        <div className='min-w-0 space-y-1'>
          <p className='text-sm leading-5 font-medium'>
            {t('Maximum tool rounds')}
          </p>
          <p className='text-muted-foreground text-xs leading-4'>
            {t(
              'The reply continues automatically up to this many tool rounds.'
            )}
          </p>
        </div>
        <Input
          aria-label={t('Maximum tool rounds')}
          className='w-16'
          disabled={props.disabled || !props.enabled}
          inputMode='numeric'
          max={PLAYGROUND_TOOL_EXECUTION_MAX_ROUNDS}
          min={PLAYGROUND_TOOL_EXECUTION_MIN_ROUNDS}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (!Number.isFinite(value)) return
            props.onMaxRoundsChange(value)
          }}
          type='number'
          value={props.maxRounds}
        />
      </div>

      <p className='text-muted-foreground border-border/70 border-t pt-3 text-xs leading-4'>
        {t(
          'Unknown tools still wait for a manual result, and every automatic continuation is billed like a normal request.'
        )}
      </p>
    </div>
  )
}

/**
 * Account-level tool loop switch of the composer. While it is on, the declared
 * executable calls of the latest assistant reply are answered automatically
 * and the conversation continues on its own up to the round cap. Unknown tools
 * keep the manual result/deny path.
 */
export function PlaygroundToolExecutionControl(
  props: PlaygroundToolExecutionControlProps
) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)

  const trigger = (
    <PromptInputButton
      aria-label={t('Tool loop')}
      aria-pressed={props.enabled}
      className={
        props.enabled
          ? 'bg-primary/10 text-primary hover:bg-primary/15 font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
      }
      disabled={props.disabled}
      variant='ghost'
    >
      <Wrench size={16} />
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Tool loop')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Tool loop')}</SheetTitle>
          </SheetHeader>
          <div className='overflow-y-auto'>
            <PlaygroundToolExecutionContent {...props} />
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Tool loop')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='w-80 max-w-[calc(100vw-2rem)] gap-2 p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        <div className='space-y-1 px-1'>
          <div className='text-sm font-semibold'>{t('Tool loop')}</div>
        </div>
        <PlaygroundToolExecutionContent {...props} />
      </PopoverContent>
    </Popover>
  )
}
