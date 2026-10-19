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
import type { NodeProps } from '@xyflow/react'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Node as CanvasNodeCard,
  NodeContent,
  NodeHeader,
  NodeTitle,
} from '@/components/ai-elements/node'
import { Badge } from '@/components/ui/badge'
import { CanvasWorkflowStatusBadge } from '@/features/canvas/components/canvas-workflow-status-badge'
import { CANVAS_NODE_KIND_LABELS } from '@/features/canvas/constants'
import type { CanvasNodeData, CanvasNodeKind } from '@/features/canvas/types'
import { cn } from '@/lib/utils'

function sharedNodePreview(data: CanvasNodeData, mediaKind: boolean): string {
  const text =
    data.text?.trim() ||
    data.snapshot?.text?.trim() ||
    data.workflow?.output?.trim() ||
    ''
  // A media node already renders `data.label` in its placeholder block; using
  // it as the preview too would print the filename twice.
  return text || (mediaKind ? '' : (data.label?.trim() ?? ''))
}

const MEDIA_KINDS: CanvasNodeKind[] = [
  'attachment',
  'image',
  'artifact',
  'video',
  'audio',
  'task-result',
]

/**
 * Read-only card of one shared canvas node. It renders only the already
 * sanitized preview fields: it never builds an attachment or artifact URL, it
 * never reads a `ref`, and it never calls a content endpoint. Media nodes show
 * their declared type and label with an explicit "not included" placeholder.
 */
export function SharedCanvasNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const data = props.data as CanvasNodeData
  const kind = data.kind ?? 'text'
  const mediaKind = MEDIA_KINDS.includes(kind)
  const preview = sharedNodePreview(data, mediaKind)
  const workflow = data.workflow

  if (kind === 'group') {
    return (
      <div className='border-border/70 bg-muted/20 size-full rounded-lg border border-dashed'>
        <span className='text-muted-foreground block truncate px-2 py-1 text-xs font-medium'>
          {preview || t('Group')}
        </span>
      </div>
    )
  }

  if (kind === 'frame') {
    return (
      <div className='border-border/80 bg-muted/10 size-full rounded-xl border'>
        <span className='bg-background/70 text-muted-foreground block h-9 truncate rounded-t-xl border-b px-3 py-2 text-xs font-medium'>
          {preview || t('Frame')}
        </span>
      </div>
    )
  }

  if (kind === 'sticky') {
    return (
      <div className='size-full rounded-lg border border-amber-300/80 bg-amber-100 p-3 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/70 dark:text-amber-50'>
        <p className='line-clamp-6 text-sm leading-5 break-words whitespace-pre-wrap'>
          {preview || t('Sticky note')}
        </p>
      </div>
    )
  }

  return (
    <CanvasNodeCard
      className='h-auto w-64 gap-0 p-0'
      handles={{ target: false, source: false }}
    >
      <NodeHeader className='flex items-center justify-between gap-2 p-2'>
        <NodeTitle className='text-xs font-medium'>
          {t(CANVAS_NODE_KIND_LABELS[kind])}
        </NodeTitle>
        {workflow?.status ? (
          <CanvasWorkflowStatusBadge status={workflow.status} />
        ) : null}
      </NodeHeader>
      <NodeContent className='grid gap-2 p-2'>
        {preview ? (
          <p className='line-clamp-6 text-sm leading-5 break-words whitespace-pre-wrap'>
            {preview}
          </p>
        ) : null}
        {mediaKind ? (
          <div
            className={cn(
              'border-border/70 bg-muted/20 flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed p-2 text-center text-xs'
            )}
          >
            <FileText
              aria-hidden='true'
              className='text-muted-foreground size-4'
            />
            {data.label ? (
              <span className='font-medium break-all'>{data.label}</span>
            ) : null}
            {data.mediaType ? (
              <span className='text-muted-foreground break-all'>
                {data.mediaType}
              </span>
            ) : null}
            <Badge variant='outline'>{t('Preview not available')}</Badge>
          </div>
        ) : null}
      </NodeContent>
    </CanvasNodeCard>
  )
}
