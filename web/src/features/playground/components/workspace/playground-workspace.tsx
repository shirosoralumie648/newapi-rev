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
import { FileText, Menu, PanelLeft } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'

import type { PlaygroundSession } from '../../types'
import { PlaygroundSessionList } from './playground-session-list'

interface PlaygroundWorkspaceProps {
  disabled?: boolean
  sessions: PlaygroundSession[]
  activeSessionId: string | null
  onCreate: () => void
  onSwitch: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
  onDelete: (sessionId: string) => void
  children: React.ReactNode
  artifactsOpen?: boolean
  artifactPanel?: React.ReactNode
  onToggleArtifacts?: () => void
  onCloseArtifacts?: () => void
  artifactDisabled?: boolean
}

export function PlaygroundWorkspace(props: PlaygroundWorkspaceProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [isSessionListOpen, setIsSessionListOpen] = useState(false)

  const sessionList = (
    <PlaygroundSessionList
      disabled={props.disabled}
      activeSessionId={props.activeSessionId}
      onAction={() => setIsSessionListOpen(false)}
      onCreate={props.onCreate}
      onDelete={props.onDelete}
      onRename={props.onRename}
      onSwitch={props.onSwitch}
      sessions={props.sessions}
    />
  )

  return (
    <div className='relative flex size-full min-h-0 overflow-hidden'>
      {isMobile ? (
        <Sheet onOpenChange={setIsSessionListOpen} open={isSessionListOpen}>
          <SheetContent className='p-0' side='left'>
            <SheetHeader className='border-b pr-12'>
              <SheetTitle>{t('Conversations')}</SheetTitle>
              <SheetDescription>
                {t('Switch between your playground conversations.')}
              </SheetDescription>
            </SheetHeader>
            <div className='flex min-h-0 flex-1 p-3'>{sessionList}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <aside className='bg-muted/10 hidden w-64 shrink-0 flex-col border-r p-3 md:flex'>
          <div className='mb-3 flex items-center gap-2 px-1'>
            <PanelLeft aria-hidden='true' className='size-4' />
            <h2 className='text-sm font-medium'>{t('Conversations')}</h2>
          </div>
          {sessionList}
        </aside>
      )}

      <div className='flex min-w-0 flex-1 flex-col overflow-hidden'>
        <div className='flex h-11 shrink-0 items-center justify-between border-b px-3'>
          <div className='flex items-center'>
            {isMobile && (
              <>
                <Button
                  aria-label={t('Open conversations')}
                  onClick={() => setIsSessionListOpen(true)}
                  size='icon-sm'
                  type='button'
                  variant='ghost'
                >
                  <Menu aria-hidden='true' />
                </Button>
                <span className='ml-2 text-sm font-medium'>
                  {t('Playground')}
                </span>
              </>
            )}
          </div>
          {props.onToggleArtifacts && (
            <Button
              aria-pressed={Boolean(props.artifactsOpen)}
              disabled={props.disabled || props.artifactDisabled}
              onClick={props.onToggleArtifacts}
              size='sm'
              type='button'
              variant={props.artifactsOpen ? 'secondary' : 'ghost'}
            >
              <FileText aria-hidden='true' />
              {t('Artifacts')}
            </Button>
          )}
        </div>
        {isMobile && <div className='min-h-0 flex-1'>{props.children}</div>}
        {!isMobile && props.artifactsOpen && props.artifactPanel && (
          <ResizablePanelGroup
            orientation='horizontal'
            className='min-h-0 flex-1'
          >
            <ResizablePanel defaultSize='62' minSize='35'>
              {props.children}
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize='38' minSize='28'>
              {props.artifactPanel}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
        {!isMobile && (!props.artifactsOpen || !props.artifactPanel) && (
          <div className='min-h-0 flex-1'>{props.children}</div>
        )}
        {isMobile && props.artifactPanel && (
          <Sheet
            open={Boolean(props.artifactsOpen)}
            onOpenChange={(open) => {
              if (!open) props.onCloseArtifacts?.()
            }}
          >
            <SheetContent
              className='w-full gap-0 p-0 sm:max-w-3xl'
              side='right'
            >
              <SheetHeader className='sr-only'>
                <SheetTitle>{t('Artifacts')}</SheetTitle>
                <SheetDescription>
                  {t('Edit and review saved artifacts.')}
                </SheetDescription>
              </SheetHeader>
              {props.artifactPanel}
            </SheetContent>
          </Sheet>
        )}
      </div>
    </div>
  )
}
