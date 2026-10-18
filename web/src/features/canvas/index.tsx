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
import { useNavigate } from '@tanstack/react-router'
import { History, Menu, PanelLeft } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { CanvasEditor } from './components/canvas-editor'
import { CanvasProjectList } from './components/canvas-project-list'
import { CanvasSnapshotHistory } from './components/canvas-snapshot-history'
import { CANVAS_DEFAULT_TITLE } from './constants'
import {
  useCanvasProject,
  type CanvasSaveStatus,
} from './hooks/use-canvas-project'
import { canvasSourceSearch } from './lib/canvas-navigation'
import type { CanvasSourceTarget } from './lib/canvas-navigation'
import type { CanvasServerDocument } from './types'

interface CanvasWorkspaceProps {
  /** Project to open on first load; overrides the last-used selection. */
  initialProjectId?: string
}

export function CanvasWorkspace(props: CanvasWorkspaceProps) {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  return (
    <CanvasWorkspaceContent
      key={userId ?? 'signed-out'}
      initialProjectId={props.initialProjectId}
    />
  )
}

const SAVE_LABELS: Record<CanvasSaveStatus, string> = {
  idle: 'Saved',
  loading: 'Loading canvas...',
  ready: 'Saved',
  saving: 'Saving...',
  error: 'Save failed',
  conflict: 'Save conflict',
}

function CanvasWorkspaceContent(props: CanvasWorkspaceProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const controller = useCanvasProject(userId, props.initialProjectId)
  const [listOpen, setListOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [epoch, setEpoch] = useState(0)

  const reportError = useCallback(
    (error: unknown) => {
      toast.error(t(getServerMessage(error) ?? 'Canvas operation failed.'))
    },
    [t]
  )

  const handleCreate = useCallback(async () => {
    try {
      await controller.createNewProject()
      setListOpen(false)
    } catch (error) {
      reportError(error)
    }
  }, [controller, reportError])

  const handleSelect = useCallback(
    async (projectId: string) => {
      try {
        await controller.selectProject(projectId)
        setListOpen(false)
      } catch (error) {
        reportError(error)
      }
    },
    [controller, reportError]
  )

  const handleRename = useCallback(
    async (projectId: string, title: string) => {
      try {
        await controller.renameProject(projectId, title)
      } catch (error) {
        reportError(error)
      }
    },
    [controller, reportError]
  )

  const handleDelete = useCallback(
    async (projectId: string) => {
      try {
        await controller.deleteProject(projectId)
      } catch (error) {
        reportError(error)
      }
    },
    [controller, reportError]
  )

  const handleReloadConflict = useCallback(async () => {
    try {
      await controller.discardLocalChanges()
      setEpoch((value) => value + 1)
    } catch (error) {
      reportError(error)
    }
  }, [controller, reportError])

  // Restoring replaces the project document in place; the epoch remounts the
  // editor so its local state initializes from the restored document.
  const handleRestoreSnapshot = useCallback(
    async (snapshotId: string) => {
      await controller.restoreSnapshot(snapshotId)
      setEpoch((value) => value + 1)
    },
    [controller]
  )

  const handleRetrySave = useCallback(async () => {
    try {
      await controller.flushNow()
    } catch (error) {
      reportError(error)
    }
  }, [controller, reportError])

  const handleDocumentChange = useCallback(
    (document: CanvasServerDocument) => {
      controller.scheduleSave(document)
    },
    [controller]
  )

  const handleOpenSource = useCallback(
    (target: CanvasSourceTarget) => {
      void navigate({ to: '/playground', search: canvasSourceSearch(target) })
    },
    [navigate]
  )

  const { project, status, error, dirty, conflict } = controller
  const projectList = (
    <CanvasProjectList
      activeProjectId={project?.id ?? null}
      disabled={status === 'loading'}
      onAction={() => setListOpen(false)}
      onCreate={handleCreate}
      onDelete={handleDelete}
      onRename={handleRename}
      onSelect={handleSelect}
      projects={controller.projects}
    />
  )
  let displayTitle = t('Canvases')
  if (project) {
    displayTitle =
      project.title === CANVAS_DEFAULT_TITLE
        ? t(CANVAS_DEFAULT_TITLE)
        : project.title
  }
  let saveLabel = t(SAVE_LABELS[status])
  if (dirty && (status === 'ready' || status === 'idle')) {
    saveLabel = t('Unsaved changes')
  }

  let body: ReactNode
  if (status === 'loading' && !project) {
    body = <LoadingState message={t('Loading canvas...')} />
  } else if (project) {
    body = (
      <CanvasEditor
        key={`${project.id}:${epoch}`}
        disabled={status === 'loading'}
        onChange={handleDocumentChange}
        onOpenSource={handleOpenSource}
        project={project}
      />
    )
  } else {
    body = (
      <EmptyState
        description={t('Create a canvas to start arranging nodes.')}
        title={t('No canvas projects yet')}
        action={
          <Button onClick={handleCreate} type='button'>
            {t('New canvas')}
          </Button>
        }
      />
    )
  }

  return (
    <div className='relative flex size-full min-h-0 overflow-hidden'>
      {isMobile ? (
        <Sheet onOpenChange={setListOpen} open={listOpen}>
          <SheetContent className='p-0' side='left'>
            <SheetHeader className='border-b pr-12'>
              <SheetTitle>{t('Canvases')}</SheetTitle>
              <SheetDescription>
                {t('Switch between your canvas projects.')}
              </SheetDescription>
            </SheetHeader>
            <div className='flex min-h-0 flex-1 p-3'>{projectList}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <aside className='bg-muted/10 hidden w-64 shrink-0 flex-col border-r p-3 md:flex'>
          <div className='mb-3 flex items-center gap-2 px-1'>
            <PanelLeft aria-hidden='true' className='size-4' />
            <h2 className='text-sm font-medium'>{t('Canvases')}</h2>
          </div>
          {projectList}
        </aside>
      )}

      <div className='flex min-w-0 flex-1 flex-col overflow-hidden'>
        <div className='flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3'>
          <div className='flex min-w-0 items-center gap-2'>
            {isMobile && (
              <Button
                aria-label={t('Open canvases')}
                onClick={() => setListOpen(true)}
                size='icon-sm'
                type='button'
                variant='ghost'
              >
                <Menu aria-hidden='true' />
              </Button>
            )}
            <span className='truncate text-sm font-medium'>{displayTitle}</span>
          </div>
          <div className='flex shrink-0 items-center gap-1'>
            {project && (
              <Button
                aria-label={t('Canvas history')}
                onClick={() => setHistoryOpen(true)}
                size='icon-sm'
                type='button'
                variant='ghost'
              >
                <History aria-hidden='true' />
              </Button>
            )}
            <span className='text-muted-foreground text-xs' role='status'>
              {saveLabel}
            </span>
          </div>
        </div>

        {conflict && (
          <div className='shrink-0'>
            <ErrorState
              className='min-h-0 p-3'
              description={t(
                'Your changes are kept locally. Reload the canvas to continue.'
              )}
              onRetry={handleReloadConflict}
              title={t('Save conflict')}
            />
          </div>
        )}
        {!conflict && status === 'error' && error && (
          <div className='shrink-0'>
            <ErrorState
              className='min-h-0 p-3'
              description={getServerMessage(error)}
              onRetry={handleRetrySave}
              title={t('Canvas could not be saved.')}
            />
          </div>
        )}

        {body}
      </div>

      {project && (
        <CanvasSnapshotHistory
          key={project.id}
          onOpenChange={setHistoryOpen}
          onRestore={handleRestoreSnapshot}
          open={historyOpen}
          projectId={project.id}
        />
      )}
    </div>
  )
}
