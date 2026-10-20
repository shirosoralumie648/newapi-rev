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
import { Bot, Brain, Compass, Images, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'

import { PlaygroundNoModelsNotice } from './playground-no-models-notice'

interface PlaygroundWelcomeProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStartTour: () => void
  /** The current group has no chat model, so the first send cannot start. */
  noAvailableModels?: boolean
}

/**
 * First-visit overview. It is a modal dialog on desktop and a bottom sheet on
 * mobile; both use the project dialog primitives for focus trapping, Escape
 * handling and focus restoration. Help reopens the same content deliberately.
 */
export function PlaygroundWelcome(props: PlaygroundWelcomeProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const features = [
    {
      icon: Sparkles,
      title: t('Chat without leaving your workspace'),
      description: t(
        'Test models, tune requests and keep every conversation organized.'
      ),
    },
    {
      icon: Bot,
      title: t('Reuse presets and memory'),
      description: t(
        'Start from saved assistants and durable notes that follow your account.'
      ),
    },
    {
      icon: Brain,
      title: t('Create on the canvas'),
      description: t(
        'Generate images and video, then arrange results, artifacts and assets on an infinite board.'
      ),
    },
  ]

  const content = (
    <div className='grid gap-4'>
      <div className='grid gap-3'>
        {features.map(({ icon: Icon, title, description }) => (
          <div className='flex gap-3' key={title}>
            <span className='bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg border'>
              <Icon aria-hidden='true' className='size-4' />
            </span>
            <div className='grid gap-0.5'>
              <p className='text-sm font-medium'>{title}</p>
              <p className='text-muted-foreground text-xs leading-5'>
                {description}
              </p>
            </div>
          </div>
        ))}
      </div>
      {props.noAvailableModels ? (
        <PlaygroundNoModelsNotice />
      ) : (
        <div className='text-muted-foreground flex items-start gap-2 text-xs leading-5'>
          <Images aria-hidden='true' className='mt-0.5 size-4 shrink-0' />
          <p>
            {t('You can replay this guide from the Help button at any time.')}
          </p>
        </div>
      )}
    </div>
  )

  const actions = (
    <>
      <Button
        onClick={() => props.onOpenChange(false)}
        type='button'
        variant='outline'
      >
        {t('Explore on my own')}
      </Button>
      <Button onClick={props.onStartTour} type='button'>
        <Compass aria-hidden='true' />
        {t('Start guided tour')}
      </Button>
    </>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={props.onOpenChange} open={props.open}>
        <SheetContent
          className='max-h-[90dvh] p-0'
          data-tour='welcome-card'
          side='bottom'
        >
          <SheetHeader className='px-4 pt-4 pb-2'>
            <div className='bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl'>
              <Sparkles aria-hidden='true' className='size-5' />
            </div>
            <SheetTitle>{t('Welcome to the Playground')}</SheetTitle>
            <SheetDescription>
              {t(
                'A quick look at the conversation workspace and the canvas creation tools.'
              )}
            </SheetDescription>
          </SheetHeader>
          <div className='min-h-0 overflow-y-auto px-4 pb-2'>{content}</div>
          <SheetFooter className='border-t px-4 py-3'>{actions}</SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogContent
        className='sm:max-w-lg'
        data-tour='welcome-card'
        showCloseButton
      >
        <DialogHeader>
          <div className='bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl'>
            <Sparkles aria-hidden='true' className='size-5' />
          </div>
          <DialogTitle>{t('Welcome to the Playground')}</DialogTitle>
          <DialogDescription>
            {t(
              'A quick look at the conversation workspace and the canvas creation tools.'
            )}
          </DialogDescription>
        </DialogHeader>
        {content}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
