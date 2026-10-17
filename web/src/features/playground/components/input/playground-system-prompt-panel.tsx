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
import { MessageSquareTextIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

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
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

type PlaygroundSystemPromptPanelProps = {
  systemPrompt: string
  disabled?: boolean
  onSystemPromptChange: (value: string) => void
}

type PlaygroundSystemPromptContentProps = PlaygroundSystemPromptPanelProps & {
  open: boolean
  compact?: boolean
}

/**
 * Editor for the conversation-level system prompt. The panel owns only the
 * draft; saving and clearing persist through the session state, and the request
 * payload injects the stored prompt as the first `system` message.
 */
function PlaygroundSystemPromptContent(
  props: PlaygroundSystemPromptContentProps
) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(props.systemPrompt)

  useEffect(() => {
    if (props.open) setDraft(props.systemPrompt)
  }, [props.open, props.systemPrompt])

  const save = () => {
    props.onSystemPromptChange(draft.trim())
    toast.success(t('System prompt saved'))
  }

  const clear = () => {
    setDraft('')
    props.onSystemPromptChange('')
    toast.success(t('System prompt cleared'))
  }

  return (
    <div className='grid gap-3 p-1'>
      <p className='text-muted-foreground px-1 text-xs leading-4'>
        {t(
          'The system prompt is sent to the model at the start of every request in this conversation.'
        )}
      </p>
      <Textarea
        aria-label={t('System prompt')}
        className={props.compact ? 'min-h-40' : 'min-h-32'}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t('e.g. You are a concise assistant.')}
        value={draft}
      />
      <div className='flex items-center justify-end gap-2'>
        <Button
          disabled={
            props.disabled || (draft === '' && props.systemPrompt === '')
          }
          onClick={clear}
          size='sm'
          type='button'
          variant='outline'
        >
          {t('Clear')}
        </Button>
        <Button
          disabled={props.disabled}
          onClick={save}
          size='sm'
          type='button'
        >
          {t('Save')}
        </Button>
      </div>
    </div>
  )
}

export function PlaygroundSystemPromptPanel(
  props: PlaygroundSystemPromptPanelProps
) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const hasPrompt = props.systemPrompt.trim() !== ''

  const trigger = (
    <PromptInputButton
      aria-label={t('System prompt')}
      aria-pressed={hasPrompt}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 relative font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <MessageSquareTextIcon size={16} />
      {hasPrompt && (
        <span
          aria-hidden='true'
          className='bg-primary absolute -top-1 -right-1 size-2 rounded-full'
        />
      )}
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('System prompt')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('System prompt')}</SheetTitle>
          </SheetHeader>
          <PlaygroundSystemPromptContent {...props} compact open={open} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('System prompt')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='w-[26rem] max-w-[calc(100vw-2rem)] gap-2 p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        <div className='space-y-1 px-1'>
          <div className='text-sm font-semibold'>{t('System prompt')}</div>
        </div>
        <PlaygroundSystemPromptContent {...props} open={open} />
      </PopoverContent>
    </Popover>
  )
}
