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
import type { NodeTypes } from '@xyflow/react'
import { Share2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Canvas } from '@/components/ai-elements/canvas'
import { EmptyState } from '@/components/empty-state'
import { fromServerDocument } from '@/features/canvas/lib/canvas-document'

import type { PlaygroundSharedCanvas } from '../../types'
import { SharedCanvasNodeView } from './shared-canvas-node'

const sharedNodeTypes: NodeTypes = {
  text: SharedCanvasNodeView,
  note: SharedCanvasNodeView,
  prompt: SharedCanvasNodeView,
  message: SharedCanvasNodeView,
  attachment: SharedCanvasNodeView,
  image: SharedCanvasNodeView,
  artifact: SharedCanvasNodeView,
  model: SharedCanvasNodeView,
  task: SharedCanvasNodeView,
  'task-result': SharedCanvasNodeView,
  video: SharedCanvasNodeView,
  audio: SharedCanvasNodeView,
  group: SharedCanvasNodeView,
}

interface PlaygroundSharedCanvasViewProps {
  /** Sanitized canvas payload returned by the public endpoint. */
  canvas: PlaygroundSharedCanvas
}

/**
 * Anonymous read-only view of one shared canvas. The server already removed
 * every reference id and media URL; this view renders the stored layout, text
 * previews and workflow status as plain React content and never reads an
 * attachment or artifact endpoint.
 */
export function PlaygroundSharedCanvasView(
  props: PlaygroundSharedCanvasViewProps
) {
  const { t } = useTranslation()
  const title = props.canvas.title.trim() || t('Untitled canvas')
  const graph = useMemo(
    () => fromServerDocument(props.canvas.document),
    [props.canvas.document]
  )

  return (
    <>
      {/* A share link is unlisted: keep it out of search indexes and prevent
          the token in the path from travelling in a Referer header. */}
      <title>{`${title} · ${t('Read-only shared canvas')}`}</title>
      <meta content='noindex, nofollow, noarchive' name='robots' />
      <meta content='no-referrer' name='referrer' />
      <main className='bg-background text-foreground flex h-svh flex-col overflow-hidden'>
        <header className='flex shrink-0 flex-col gap-2 border-b px-4 py-4 sm:px-6'>
          <div className='text-muted-foreground flex items-center gap-2 text-sm'>
            <Share2 aria-hidden='true' className='size-4' />
            <span>{t('Read-only shared canvas')}</span>
          </div>
          <h1 className='text-2xl font-semibold break-words'>{title}</h1>
          <p className='text-muted-foreground text-sm'>
            {t(
              'This is a read-only copy of a canvas shared by a Playground user. Media previews are not included.'
            )}
          </p>
        </header>

        <section
          aria-label={t('Shared canvas')}
          className='relative min-h-0 flex-1'
        >
          {graph.nodes.length === 0 ? (
            <div className='flex h-full items-center justify-center p-4'>
              <EmptyState
                bordered
                className='w-full max-w-xl'
                description={t('The shared canvas has no nodes.')}
                title={t('No nodes')}
              />
            </div>
          ) : (
            <Canvas
              defaultViewport={graph.viewport}
              deleteKeyCode={null}
              edges={graph.edges}
              elementsSelectable={false}
              fitView={!graph.viewport}
              nodes={graph.nodes}
              nodesConnectable={false}
              nodesDraggable={false}
              nodeTypes={sharedNodeTypes}
              panOnDrag
              selectionOnDrag={false}
            />
          )}
        </section>

        <footer className='text-muted-foreground shrink-0 border-t px-4 py-3 text-center text-xs'>
          {t('The owner of this canvas can revoke this link at any time.')}
        </footer>
      </main>
    </>
  )
}
