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
import { Frame } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getCanvasProject, listCanvasProjects } from '@/features/canvas/api'
import { CANVAS_NODE_KIND_LABELS } from '@/features/canvas/constants'
import { fromServerDocument } from '@/features/canvas/lib/canvas-document'
import type {
  CanvasFlowNode,
  CanvasProjectSummary,
  CanvasServerProject,
} from '@/features/canvas/types'
import { getServerMessage } from '@/lib/server-error-message'

interface PlaygroundCanvasPanelProps {
  /** Project to focus, e.g. the canvas a message was just sent to. */
  activeProjectId: string | null
  onOpenProject: (projectId: string) => void
}

type LoadStatus = 'loading' | 'ready' | 'error'

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function nodePreviewText(node: CanvasFlowNode): string {
  const data = node.data
  return (
    data.text?.trim() ||
    data.snapshot?.text?.trim() ||
    data.label?.trim() ||
    ''
  )
}

/**
 * Read-only canvas preview inside the Playground Inspector. It lists the
 * signed-in account's canvases and renders the selected document's nodes, with
 * an explicit jump to the full canvas editor. Only owner-scoped endpoints are
 * used, so an unowned project id simply fails the read.
 */
export function PlaygroundCanvasPanel(props: PlaygroundCanvasPanelProps) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([])
  const [listStatus, setListStatus] = useState<LoadStatus>('loading')
  const [listError, setListError] = useState<Error | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    props.activeProjectId
  )
  const [preview, setPreview] = useState<CanvasServerProject | null>(null)
  const [previewStatus, setPreviewStatus] = useState<LoadStatus>('loading')
  const [previewError, setPreviewError] = useState<Error | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    setListStatus('loading')
    setListError(null)
    void listCanvasProjects()
      .then((rows) => {
        if (!active) return
        setProjects(rows)
        setSelectedId((current) => {
          if (current && rows.some((row) => row.id === current)) return current
          return rows[0]?.id ?? null
        })
        setListStatus('ready')
      })
      .catch((error) => {
        if (!active) return
        setListError(toError(error))
        setListStatus('error')
      })
    return () => {
      active = false
    }
  }, [refreshKey])

  useEffect(() => {
    if (props.activeProjectId) setSelectedId(props.activeProjectId)
  }, [props.activeProjectId])

  useEffect(() => {
    if (!selectedId) {
      setPreview(null)
      setPreviewStatus('ready')
      return
    }
    let active = true
    setPreviewStatus('loading')
    setPreviewError(null)
    void getCanvasProject(selectedId)
      .then((project) => {
        if (!active) return
        setPreview(project)
        setPreviewStatus('ready')
      })
      .catch((error) => {
        if (!active) return
        setPreviewError(toError(error))
        setPreviewStatus('error')
      })
    return () => {
      active = false
    }
  }, [selectedId, refreshKey])

  const nodes: CanvasFlowNode[] = preview
    ? fromServerDocument(preview.document).nodes
    : []

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='border-b px-3 py-2 text-xs font-medium'>
        {t('Canvases')}
      </div>

      {listStatus === 'error' && (
        <div className='shrink-0 p-2'>
          <ErrorState
            className='min-h-0 p-2'
            description={getServerMessage(listError)}
            onRetry={() => setRefreshKey((value) => value + 1)}
            title={t('Unable to load canvases.')}
          />
        </div>
      )}

      {listStatus === 'ready' && projects.length === 0 && (
        <div className='flex min-h-0 flex-1 items-center justify-center p-4'>
          <EmptyState
            description={t('Create a canvas to start arranging nodes.')}
            title={t('No canvas projects yet')}
          />
        </div>
      )}

      {(listStatus === 'loading' || projects.length > 0) && (
        <>
          <ScrollArea className='max-h-48 shrink-0 border-b'>
            <div className='grid gap-1 p-2'>
              {listStatus === 'loading' && (
                <LoadingState className='min-h-16' />
              )}
              {projects.map((project) => (
                <Button
                  aria-current={
                    project.id === selectedId ? 'true' : undefined
                  }
                  className='h-auto min-w-0 justify-start px-2 py-2 text-left'
                  key={project.id}
                  onClick={() => setSelectedId(project.id)}
                  type='button'
                  variant={project.id === selectedId ? 'secondary' : 'ghost'}
                >
                  <span className='truncate'>{project.title}</span>
                </Button>
              ))}
            </div>
          </ScrollArea>

          <div className='flex min-h-0 flex-1 flex-col gap-3 p-3'>
            {previewStatus === 'loading' && (
              <LoadingState className='min-h-24 flex-1' />
            )}
            {previewStatus === 'error' && (
              <ErrorState
                className='min-h-0'
                description={getServerMessage(previewError)}
                onRetry={() => setRefreshKey((value) => value + 1)}
                title={t('Unable to load the canvas.')}
              />
            )}
            {previewStatus === 'ready' && selectedId && (
              <>
                <div className='flex items-center justify-between gap-2'>
                  <span className='text-muted-foreground text-xs'>
                    {t('Nodes: {{count}}', { count: nodes.length })}
                  </span>
                  <Button
                    onClick={() => props.onOpenProject(selectedId)}
                    size='sm'
                    type='button'
                  >
                    <Frame aria-hidden='true' />
                    {t('Open canvas')}
                  </Button>
                </div>
                <ScrollArea className='min-h-0 flex-1'>
                  <ul className='grid gap-2 pr-2'>
                    {nodes.map((node) => (
                      <li
                        className='rounded-md border p-2'
                        key={node.id}
                      >
                        <p className='text-xs font-medium'>
                          {t(CANVAS_NODE_KIND_LABELS[node.data.kind])}
                        </p>
                        <p className='text-muted-foreground line-clamp-2 text-xs break-words whitespace-pre-wrap'>
                          {nodePreviewText(node) || t('Empty node')}
                        </p>
                      </li>
                    ))}
                    {nodes.length === 0 && (
                      <li className='text-muted-foreground py-4 text-center text-xs'>
                        {t('This canvas has no nodes yet.')}
                      </li>
                    )}
                  </ul>
                </ScrollArea>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
