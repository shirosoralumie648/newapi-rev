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
  FileText,
  FolderOpen,
  Frame,
  Menu,
  PanelLeft,
  Sparkles,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { WorkspaceInspector } from '@/components/workspace-inspector'
import { useIsMobile } from '@/hooks/use-mobile'

import type { PlaygroundSession } from '../../types'
import { PlaygroundSessionList } from './playground-session-list'

/**
 * Which view the unified right-side Inspector shows. The Inspector itself is
 * owner of the desktop resizable layout and the mobile Sheet.
 */
export type PlaygroundInspectorView =
  | 'artifacts'
  | 'canvas'
  | 'generate'
  | 'library'
  | 'presets'
  | 'trash'

interface PlaygroundWorkspaceProps {
  disabled?: boolean
  sessions: PlaygroundSession[]
  activeSessionId: string | null
  onCreate: () => void
  onSwitch: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
  onDelete: (sessionId: string) => void
  children: React.ReactNode
  usagePanel?: React.ReactNode
  inspectorView: PlaygroundInspectorView | null
  inspector: React.ReactNode
  onToggleInspector: (view: PlaygroundInspectorView) => void
  onCloseInspector: () => void
  artifactsDisabled?: boolean
  onOpenTrash?: () => void
  onOpenPresets?: () => void
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
      onOpenPresets={props.onOpenPresets}
      onOpenTrash={props.onOpenTrash}
      onRename={props.onRename}
      onSwitch={props.onSwitch}
      sessions={props.sessions}
    />
  )

  let inspectorTitle = t('Artifacts')
  let inspectorDescription = t('Edit and review saved artifacts.')
  if (props.inspectorView === 'canvas') {
    inspectorTitle = t('Canvases')
    inspectorDescription = t('Switch between your canvas projects.')
  } else if (props.inspectorView === 'generate') {
    inspectorTitle = t('Generate')
    inspectorDescription = t(
      'Generate images, videos and audio through your configured channels.'
    )
  } else if (props.inspectorView === 'library') {
    inspectorTitle = t('Asset library')
    inspectorDescription = t(
      'Attachments, artifacts and generation results in your Playground.'
    )
  } else if (props.inspectorView === 'presets') {
    inspectorTitle = t('Assistant presets')
    inspectorDescription = t(
      'Reusable assistants with their own model, parameters and system prompt.'
    )
  } else if (props.inspectorView === 'trash') {
    inspectorTitle = t('Trash')
    inspectorDescription = t(
      'Deleted conversations and canvases stay recoverable until the retention period ends.'
    )
  }

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
          <div className='flex items-center gap-1'>
            {props.usagePanel}
            <Button
              aria-pressed={props.inspectorView === 'generate'}
              disabled={props.disabled}
              onClick={() => props.onToggleInspector('generate')}
              size='sm'
              type='button'
              variant={
                props.inspectorView === 'generate' ? 'secondary' : 'ghost'
              }
            >
              <Sparkles aria-hidden='true' />
              {t('Generate')}
            </Button>
            <Button
              aria-pressed={props.inspectorView === 'canvas'}
              disabled={props.disabled}
              onClick={() => props.onToggleInspector('canvas')}
              size='sm'
              type='button'
              variant={props.inspectorView === 'canvas' ? 'secondary' : 'ghost'}
            >
              <Frame aria-hidden='true' />
              {t('Canvases')}
            </Button>
            <Button
              aria-pressed={props.inspectorView === 'artifacts'}
              disabled={props.disabled || props.artifactsDisabled}
              onClick={() => props.onToggleInspector('artifacts')}
              size='sm'
              type='button'
              variant={
                props.inspectorView === 'artifacts' ? 'secondary' : 'ghost'
              }
            >
              <FileText aria-hidden='true' />
              {t('Artifacts')}
            </Button>
            <Button
              aria-pressed={props.inspectorView === 'library'}
              disabled={props.disabled}
              onClick={() => props.onToggleInspector('library')}
              size='sm'
              type='button'
              variant={
                props.inspectorView === 'library' ? 'secondary' : 'ghost'
              }
            >
              <FolderOpen aria-hidden='true' />
              {t('Library')}
            </Button>
          </div>
        </div>
        <WorkspaceInspector
          open={props.inspectorView !== null}
          onClose={props.onCloseInspector}
          title={inspectorTitle}
          description={inspectorDescription}
          main={props.children}
        >
          {props.inspector}
        </WorkspaceInspector>
      </div>
    </div>
  )
}
