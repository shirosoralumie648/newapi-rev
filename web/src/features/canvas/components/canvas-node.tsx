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
import { NodeResizer, type NodeProps } from '@xyflow/react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  ImageIcon,
  Music,
  Unlink,
  Video,
} from 'lucide-react'
import { createContext, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Node as CanvasNodeCard,
  NodeContent,
  NodeHeader,
  NodeTitle,
} from '@/components/ai-elements/node'
import { Badge } from '@/components/ui/badge'
import { playgroundAttachmentKind } from '@/features/playground/constants'
import { useAttachmentPreviewUrl } from '@/features/playground/hooks/use-attachment-preview-url'
import { TaskArtifactMedia } from '@/features/usage-logs/components/task-artifacts'
import { translateServerText } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  CANVAS_FRAME_MIN_HEIGHT,
  CANVAS_FRAME_MIN_WIDTH,
  CANVAS_NODE_COLOR_BORDER_CLASSES,
  CANVAS_NODE_COLOR_DOT_CLASSES,
  CANVAS_NODE_COLOR_LABELS,
  CANVAS_NODE_KIND_LABELS,
  CANVAS_STICKY_MIN_HEIGHT,
  CANVAS_STICKY_MIN_WIDTH,
} from '../constants'
import { useCanvasNodeArtifact } from '../hooks/use-canvas-node-artifact'
import type { CanvasNodeColor, CanvasNodeData, CanvasNodeKind } from '../types'
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

const CANVAS_ATTACHMENT_ICONS = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  file: FileText,
} as const

/** Editor actions a node view can trigger without knowing the hook. */
export interface CanvasNodeActions {
  onToggleGroupCollapsed?: (groupId: string) => void
}

export const CanvasNodeActionsContext = createContext<CanvasNodeActions>({})

export function CanvasNodeColorDot(props: { color?: CanvasNodeColor }) {
  const { t } = useTranslation()
  if (!props.color) return null
  return (
    <span
      aria-label={t(CANVAS_NODE_COLOR_LABELS[props.color])}
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        CANVAS_NODE_COLOR_DOT_CLASSES[props.color]
      )}
      role='img'
    />
  )
}

function CanvasNodeTags(props: { tags?: string[] }) {
  if (!props.tags || props.tags.length === 0) return null
  return (
    <div className='flex flex-wrap gap-1'>
      {props.tags.map((tag) => (
        <Badge
          className='max-w-full truncate text-[10px]'
          key={tag}
          variant='outline'
        >
          {tag}
        </Badge>
      ))}
    </div>
  )
}

/**
 * A `group` node is a plain dashed box: it carries no content and no handles,
 * it only moves its children with it. The label is optional and editable
 * through the inspector like any other node text.
 */
export function CanvasGroupNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const actions = useContext(CanvasNodeActionsContext)
  const data = props.data as CanvasNodeData
  const collapsed = data.collapsed === true
  return (
    <div
      className={cn(
        'bg-muted/20 size-full rounded-lg border border-dashed',
        data.color
          ? CANVAS_NODE_COLOR_BORDER_CLASSES[data.color]
          : 'border-border/70',
        props.selected && 'ring-ring ring-2'
      )}
    >
      <div className='flex items-center gap-1.5 px-2 py-1'>
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('Expand group') : t('Collapse group')}
          className='text-muted-foreground hover:text-foreground hover:bg-muted rounded p-0.5'
          disabled={!actions.onToggleGroupCollapsed}
          onClick={(event) => {
            event.stopPropagation()
            actions.onToggleGroupCollapsed?.(props.id)
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type='button'
        >
          {collapsed ? (
            <ChevronRight aria-hidden='true' className='size-3.5' />
          ) : (
            <ChevronDown aria-hidden='true' className='size-3.5' />
          )}
        </button>
        <CanvasNodeColorDot color={data.color} />
        <span className='text-muted-foreground min-w-0 truncate text-xs font-medium'>
          {readNodePreview(data) || t('Group')}
        </span>
        {collapsed ? (
          <Badge className='shrink-0 text-[10px]' variant='secondary'>
            {t('Collapsed')}
          </Badge>
        ) : null}
      </div>
      {data.tags && data.tags.length > 0 ? (
        <div className='px-2 pb-1'>
          <CanvasNodeTags tags={data.tags} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * A frame is a titled region painted below the cards it contains. Membership is
 * geometric, so it is not a group parent. The header is the drag surface and
 * the body stays click-through; resizing writes width/height through the normal
 * node-change pipeline, which keeps the edit undoable and autosaved.
 */
export function CanvasFrameNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const data = props.data as CanvasNodeData
  return (
    <div
      className={cn(
        'bg-muted/10 relative size-full rounded-xl border',
        data.color
          ? CANVAS_NODE_COLOR_BORDER_CLASSES[data.color]
          : 'border-border/80',
        props.selected && 'ring-ring ring-2'
      )}
    >
      <NodeResizer
        isVisible={props.selected}
        minHeight={CANVAS_FRAME_MIN_HEIGHT}
        minWidth={CANVAS_FRAME_MIN_WIDTH}
      />
      <div className='bg-background/70 flex h-9 cursor-grab items-center gap-1.5 rounded-t-xl border-b px-3'>
        <CanvasNodeColorDot color={data.color} />
        <span className='text-muted-foreground min-w-0 truncate text-xs font-medium'>
          {readNodePreview(data) || t('Frame')}
        </span>
        {data.tags && data.tags.length > 0 ? (
          <div className='ml-auto min-w-0'>
            <CanvasNodeTags tags={data.tags} />
          </div>
        ) : null}
      </div>
      <div className='pointer-events-none absolute inset-x-0 top-9 bottom-0' />
    </div>
  )
}

/** A plain text sticky note is an annotation, not a workflow node. */
export function CanvasStickyNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const data = props.data as CanvasNodeData
  const preview = readNodePreview(data)
  return (
    <div
      className={cn(
        'border-amber-300/80 bg-amber-100 text-amber-950 relative size-full rounded-lg border p-3 shadow-sm dark:border-amber-500/40 dark:bg-amber-950/70 dark:text-amber-50',
        data.color && CANVAS_NODE_COLOR_BORDER_CLASSES[data.color],
        props.selected && 'ring-ring ring-2'
      )}
    >
      <NodeResizer
        isVisible={props.selected}
        minHeight={CANVAS_STICKY_MIN_HEIGHT}
        minWidth={CANVAS_STICKY_MIN_WIDTH}
      />
      <p className='line-clamp-6 text-sm leading-5 break-words whitespace-pre-wrap'>
        {preview || t('Sticky note')}
      </p>
      {data.tags && data.tags.length > 0 ? (
        <div className='mt-2'>
          <CanvasNodeTags tags={data.tags} />
        </div>
      ) : null}
    </div>
  )
}

export function CanvasFlowNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const data = props.data as CanvasNodeData
  const kind: CanvasNodeKind = data.kind ?? 'text'
  const preview = readNodePreview(data)
  const reference = data.ref
  const workflow = data.workflow
  const sourceDeleted = data.sourceDeleted === true
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null)
  const isAttachmentNode =
    (kind === 'attachment' || kind === 'image') &&
    Boolean(reference?.attachmentId)
  const attachmentUrl = useAttachmentPreviewUrl(
    isAttachmentNode && !sourceDeleted ? reference?.sessionId : undefined,
    isAttachmentNode && !sourceDeleted ? reference?.attachmentId : undefined
  )
  // A `video`/`audio` node plays one artifact of a settled generation task.
  // The bytes are read through the owner-scoped task artifact endpoint; the
  // node itself never stores a provider URL.
  const isMediaNode = kind === 'video' || kind === 'audio'
  const mediaArtifact = useCanvasNodeArtifact(
    isMediaNode && !sourceDeleted ? reference?.taskId : undefined,
    reference?.taskArtifactKey,
    kind === 'audio' ? 'audio' : 'video'
  )
  const mediaUrl = mediaArtifact.artifact?.content_url
  const mediaFailed = Boolean(mediaUrl && failedMediaUrl === mediaUrl)
  const mediaUnavailable = mediaFailed || (isMediaNode && mediaArtifact.isError)
  const MediaIcon = kind === 'audio' ? Music : Video
  const attachmentKind = playgroundAttachmentKind(data.mediaType)
  const AttachmentIcon = CANVAS_ATTACHMENT_ICONS[attachmentKind]
  const attachmentFailed = Boolean(
    attachmentUrl && failedMediaUrl === attachmentUrl
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
        <NodeTitle className='flex min-w-0 items-center gap-1.5 text-xs font-medium'>
          <CanvasNodeColorDot color={data.color} />
          <span className='truncate'>{t(CANVAS_NODE_KIND_LABELS[kind])}</span>
        </NodeTitle>
        <div className='flex items-center gap-1'>
          {workflow?.preferred ? (
            <Badge variant='secondary'>{t('Preferred')}</Badge>
          ) : null}
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
            {attachmentUrl && !attachmentFailed ? (
              attachmentKind === 'file' ? (
                <a
                  className='text-muted-foreground hover:text-foreground flex h-24 flex-col items-center justify-center gap-1 p-2 text-xs'
                  href={attachmentUrl}
                  target='_blank'
                  rel='noreferrer'
                >
                  <FileText className='size-5' aria-hidden='true' />
                  {t('Open file')}
                </a>
              ) : (
                <div className='max-h-40 overflow-hidden'>
                  <TaskArtifactMedia
                    artifact={{
                      key: reference?.attachmentId ?? '',
                      type: attachmentKind,
                    }}
                    mediaUrl={attachmentUrl}
                    onError={() => setFailedMediaUrl(attachmentUrl)}
                  />
                </div>
              )
            ) : (
              <div className='text-muted-foreground flex h-24 flex-col items-center justify-center gap-1'>
                <AttachmentIcon className='size-5' aria-hidden='true' />
                {attachmentFailed ? (
                  <span className='text-xs'>{t('Preview unavailable')}</span>
                ) : null}
              </div>
            )}
            <figcaption className='text-muted-foreground truncate px-2 py-1 text-xs'>
              {preview || t('Attachment')}
            </figcaption>
          </figure>
        ) : null}
        {isMediaNode ? (
          <figure className='border-border/70 bg-muted/20 overflow-hidden rounded-md border'>
            {!sourceDeleted && mediaArtifact.artifact && !mediaFailed ? (
              <TaskArtifactMedia
                artifact={mediaArtifact.artifact}
                mediaUrl={mediaArtifact.artifact.content_url}
                onError={() => setFailedMediaUrl(mediaUrl ?? null)}
              />
            ) : (
              <div className='text-muted-foreground flex h-24 flex-col items-center justify-center gap-1'>
                <MediaIcon className='size-5' aria-hidden='true' />
                <span className='text-xs'>
                  {mediaUnavailable
                    ? t('Preview unavailable')
                    : t('Empty node')}
                </span>
              </div>
            )}
            {preview ? (
              <figcaption className='text-muted-foreground truncate px-2 py-1 text-xs'>
                {preview}
              </figcaption>
            ) : null}
          </figure>
        ) : null}
        {!isAttachmentNode && !isMediaNode && preview ? (
          <p className='text-muted-foreground line-clamp-4 text-xs break-words whitespace-pre-wrap'>
            {preview}
          </p>
        ) : null}
        {!isAttachmentNode && !isMediaNode && !preview ? (
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
        <CanvasNodeTags tags={data.tags} />
      </NodeContent>
    </CanvasNodeCard>
  )
}
