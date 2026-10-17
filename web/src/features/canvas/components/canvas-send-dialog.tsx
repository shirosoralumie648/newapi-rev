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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { getServerMessage } from '@/lib/server-error-message'

import { listCanvasProjects } from '../api'
import { CANVAS_DEFAULT_TITLE, CANVAS_MAX_NODES } from '../constants'
import {
  CANVAS_SEND_ERRORS,
  createCanvasWithNodes,
  sendNodesToCanvas,
  type CanvasSendSeed,
} from '../lib/canvas-send'
import type { CanvasProjectSummary } from '../types'

interface CanvasSendDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  seeds: CanvasSendSeed[]
  onSent?: () => void
}

/**
 * Picker for appending Playground nodes to the signed-in account's canvases.
 * The dialog only chooses a target; ownership of the referenced resources is
 * re-verified by the server when the document is saved.
 */
export function CanvasSendDialog(props: CanvasSendDialogProps) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  )
  const [error, setError] = useState<Error | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const reportError = useCallback(
    (value: unknown) => {
      toast.error(t(getServerMessage(value) ?? CANVAS_SEND_ERRORS.FAILED))
    },
    [t]
  )

  const refresh = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const rows = await listCanvasProjects()
      setProjects(rows)
      setStatus('ready')
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError : new Error(String(loadError))
      )
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    if (!props.open) return
    setNewTitle('')
    void refresh()
  }, [props.open, refresh])

  const sendToProject = async (projectId: string) => {
    if (pendingId !== null || isCreating) return
    setPendingId(projectId)
    try {
      await sendNodesToCanvas(projectId, props.seeds)
      props.onSent?.()
      props.onOpenChange(false)
    } catch (sendError) {
      reportError(sendError)
    } finally {
      setPendingId(null)
    }
  }

  const createAndSend = async () => {
    const title = newTitle.trim()
    if (!title || pendingId !== null || isCreating) return
    setIsCreating(true)
    try {
      await createCanvasWithNodes(title, props.seeds)
      props.onSent?.()
      props.onOpenChange(false)
    } catch (createError) {
      reportError(createError)
    } finally {
      setIsCreating(false)
    }
  }

  const busy = pendingId !== null || isCreating
  const overflow = props.seeds.length > CANVAS_MAX_NODES

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Send to canvas')}
      description={t(
        'Add these nodes to one of your canvases, or create a new one.'
      )}
      contentClassName='sm:max-w-md'
      contentHeight='auto'
      bodyClassName='grid gap-3'
    >
      {status === 'loading' && <LoadingState className='min-h-20' />}
      {status === 'error' && (
        <ErrorState
          className='min-h-0'
          title={t('Unable to load canvases.')}
          description={getServerMessage(error)}
          onRetry={() => void refresh()}
        />
      )}
      {status === 'ready' && (
        <div className='grid max-h-60 gap-1 overflow-y-auto'>
          {projects.map((project) => {
            const displayTitle =
              project.title === CANVAS_DEFAULT_TITLE
                ? t(CANVAS_DEFAULT_TITLE)
                : project.title
            return (
              <Button
                className='justify-between gap-2'
                disabled={busy || overflow}
                key={project.id}
                onClick={() => void sendToProject(project.id)}
                type='button'
                variant='outline'
              >
                <span className='truncate'>{displayTitle}</span>
                {pendingId === project.id ? (
                  <Spinner />
                ) : (
                  <span className='text-muted-foreground shrink-0 text-xs'>
                    {t('Nodes: {{count}}', { count: project.nodeCount })}
                  </span>
                )}
              </Button>
            )
          })}
          {projects.length === 0 && (
            <p className='text-muted-foreground px-1 py-4 text-center text-sm'>
              {t('No canvas projects yet')}
            </p>
          )}
        </div>
      )}

      <div className='flex items-end gap-2'>
        <div className='grid flex-1 gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Create a new canvas')}
          </span>
          <Input
            aria-label={t('Canvas name')}
            maxLength={200}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder={t('Canvas name')}
            value={newTitle}
          />
        </div>
        <Button
          disabled={!newTitle.trim() || busy || overflow}
          onClick={() => void createAndSend()}
          type='button'
        >
          {isCreating && <Spinner />}
          {t('Add to canvas')}
        </Button>
      </div>
    </Dialog>
  )
}
