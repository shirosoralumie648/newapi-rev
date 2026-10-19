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
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
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

type PlaygroundAutoTitleControlProps = {
  disabled?: boolean
  /** Effective value of the active conversation. */
  enabled: boolean
  /** Account default applied to conversations without an override. */
  defaultEnabled: boolean
  /** Whether the active conversation carries its own explicit choice. */
  hasOverride: boolean
  onEnabledChange: (value: boolean) => void
  onUseDefault: () => void
  onDefaultChange: (value: boolean) => void
}

function PlaygroundAutoTitleContent(props: PlaygroundAutoTitleControlProps) {
  const { t } = useTranslation()

  return (
    <div className='grid gap-3 px-1 pb-1'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <p className='text-sm leading-5 font-medium'>
            {t('Auto-name this conversation')}
          </p>
          <p className='text-muted-foreground text-xs leading-4'>
            {t(
              'Name each conversation automatically after its first completed reply.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t('Auto-name this conversation')}
          checked={props.enabled}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onEnabledChange(checked)}
          size='sm'
        />
      </div>

      {props.hasOverride ? (
        <Button
          className='justify-start'
          disabled={props.disabled}
          onClick={() => props.onUseDefault()}
          size='sm'
          type='button'
          variant='outline'
        >
          {t('Use account default')}
        </Button>
      ) : null}

      <div className='border-border/70 flex items-start justify-between gap-3 border-t pt-3'>
        <div className='min-w-0 space-y-1'>
          <p className='text-sm leading-5 font-medium'>
            {t('New conversations are named automatically')}
          </p>
          <p className='text-muted-foreground text-xs leading-4'>
            {t('This default also applies to conversations without a choice.')}
          </p>
        </div>
        <Switch
          aria-label={t('New conversations are named automatically')}
          checked={props.defaultEnabled}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onDefaultChange(checked)}
          size='sm'
        />
      </div>

      <p className='text-muted-foreground border-border/70 border-t pt-3 text-xs leading-4'>
        {t(
          'Titles are generated with the summary model and billed like a normal request.'
        )}
      </p>
    </div>
  )
}

/**
 * Automatic conversation naming switch of the composer. The account default
 * applies to every conversation without an explicit choice; the switch writes
 * a conversation override, and "Use account default" removes it again. Titles
 * are proposed through the ordinary `/pg/chat/completions` relay route and the
 * existing rename/autosave chain.
 */
export function PlaygroundAutoTitleControl(
  props: PlaygroundAutoTitleControlProps
) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)

  const trigger = (
    <PromptInputButton
      aria-label={t('Auto-name conversations')}
      aria-pressed={props.enabled}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <Sparkles size={16} />
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Auto-name conversations')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Auto-name conversations')}</SheetTitle>
          </SheetHeader>
          <div className='overflow-y-auto'>
            <PlaygroundAutoTitleContent {...props} />
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
          <p>{t('Auto-name conversations')}</p>
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
          <div className='text-sm font-semibold'>
            {t('Auto-name conversations')}
          </div>
        </div>
        <PlaygroundAutoTitleContent {...props} />
      </PopoverContent>
    </Popover>
  )
}
