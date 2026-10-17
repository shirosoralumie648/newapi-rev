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
import { ImageIcon, Unlink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Node as CanvasNodeCard,
  NodeContent,
  NodeHeader,
  NodeTitle,
} from '@/components/ai-elements/node'
import { Badge } from '@/components/ui/badge'
import { playgroundAttachmentContentUrl } from '@/features/playground/api'
import {
  getPlaygroundAttachmentObjectUrl,
  loadPlaygroundAttachment,
} from '@/features/playground/lib/attachment-store'
import { translateServerText } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { CANVAS_NODE_KIND_LABELS } from '../constants'
import type { CanvasNodeData, CanvasNodeKind } from '../types'
import { CanvasWorkflowStatusBadge } from './canvas-workflow-status-badge'

function readNodePreview(data: CanvasNodeData): string {
  return (
    data.text?.trim() ||
    data.snapshot?.text?.trim() ||
    data.workflow?.output?.trim() ||
    data.label?.trim() ||
    ''
  )
}

/**
 * Resolves an attachment node's preview through the owner-scoped content
 * endpoint. The node stores IDs only, so a missing session or attachment
 * simply renders the placeholder and never fetches an unowned URL.
 */
function useCanvasAttachmentUrl(
  sessionId?: string,
  attachmentId?: string
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() =>
    attachmentId ? getPlaygroundAttachmentObjectUrl(attachmentId) : undefined
  )

  useEffect(() => {
    if (url || !sessionId || !attachmentId) return
    let active = true
    void loadPlaygroundAttachment(
      playgroundAttachmentContentUrl(sessionId, attachmentId),
      attachmentId
    )
      .then((entry) => {
        if (active) setUrl(entry.objectUrl ?? entry.dataUrl)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [attachmentId, sessionId, url])

  return url
}

export function CanvasFlowNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const data = props.data as CanvasNodeData
  const kind: CanvasNodeKind = data.kind ?? 'text'
  const preview = readNodePreview(data)
  const reference = data.ref
  const workflow = data.workflow
  const sourceDeleted = data.sourceDeleted === true
  const isAttachmentNode =
    (kind === 'attachment' || kind === 'image') &&
    Boolean(reference?.attachmentId)
  const attachmentUrl = useCanvasAttachmentUrl(
    isAttachmentNode && !sourceDeleted ? reference?.sessionId : undefined,
    isAttachmentNode && !sourceDeleted ? reference?.attachmentId : undefined
  )

  return (
    <CanvasNodeCard
      className={cn(
        'h-auto w-64 gap-0 p-0',
        props.selected && 'ring-ring ring-2'
      )}
      handles={{ target: true, source: true }}
    >
      <NodeHeader className='flex items-center justify-between gap-2 p-2'>
        <NodeTitle className='text-xs font-medium'>
          {t(CANVAS_NODE_KIND_LABELS[kind])}
        </NodeTitle>
        <div className='flex items-center gap-1'>
          {workflow?.status ? (
            <CanvasWorkflowStatusBadge status={workflow.status} />
          ) : null}
          {sourceDeleted ? (
            <Badge variant='warning'>
              <Unlink aria-hidden='true' />
              {t('Source deleted')}
            </Badge>
          ) : null}
        </div>
      </NodeHeader>
      <NodeContent className='grid gap-2 p-2'>
        {isAttachmentNode ? (
          <figure className='border-border/70 bg-muted/20 overflow-hidden rounded-md border'>
            {attachmentUrl ? (
              <img
                alt={preview || t('Attachment')}
                className='max-h-40 w-full object-cover'
                src={attachmentUrl}
              />
            ) : (
              <div className='text-muted-foreground flex h-24 items-center justify-center'>
                <ImageIcon className='size-5' />
              </div>
            )}
            <figcaption className='text-muted-foreground truncate px-2 py-1 text-xs'>
              {preview || t('Attachment')}
            </figcaption>
          </figure>
        ) : null}
        {!isAttachmentNode && preview ? (
          <p className='text-muted-foreground line-clamp-4 text-xs break-words whitespace-pre-wrap'>
            {preview}
          </p>
        ) : null}
        {!isAttachmentNode && !preview ? (
          <p className='text-muted-foreground text-xs italic'>
            {t('Empty node')}
          </p>
        ) : null}
        {workflow?.error ? (
          <p className='text-destructive line-clamp-4 text-xs break-words whitespace-pre-wrap'>
            {translateServerText(t, workflow.error)}
          </p>
        ) : null}
        {workflow?.taskId ? (
          <p className='text-muted-foreground truncate font-mono text-xs'>
            {t('Task ID')}: {workflow.taskId}
          </p>
        ) : null}
        {sourceDeleted ? (
          <p className='text-muted-foreground text-xs italic'>
            {t('The original was deleted. A saved snapshot is shown instead.')}
          </p>
        ) : null}
      </NodeContent>
    </CanvasNodeCard>
  )
}
