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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Spinner } from '@/components/ui/spinner'
import { translateServerText } from '@/lib/server-error-message'

import { CANVAS_IMAGE_TOOL_MESSAGES } from '../../constants'
import {
  canvasImageToolSource,
  type CanvasImageToolSource,
} from '../../lib/canvas-image-tools'
import type { CanvasWorkflowImageSource } from '../../lib/canvas-workflow'
import {
  CanvasWorkflowImageError,
  readCanvasWorkflowImage,
} from '../../lib/canvas-workflow-images'
import type { CanvasFlowNode } from '../../types'

interface CanvasImageWorkbenchPreviewProps {
  /** Result node whose stored image is shown; null renders nothing. */
  node: CanvasFlowNode | null
  /**
   * A transient image of the current run. It wins over the stored source so a
   * just-generated inline image shows before a task settles.
   */
  preview?: string
  /** Local zoom of the main preview; thumbnails pass the default. */
  zoom?: number
  className?: string
  alt: string
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string }

/** The stable identity of a source, used to refresh only when it changes. */
function sourceKey(source: CanvasImageToolSource | null): string {
  if (!source) return ''
  return source.kind === 'attachment'
    ? `attachment:${source.sessionId}:${source.attachmentId}`
    : `task-result:${source.taskId}:${source.artifactKey ?? ''}`
}

function previewErrorMessage(error: unknown): string {
  return error instanceof CanvasWorkflowImageError
    ? error.messageKey
    : CANVAS_IMAGE_TOOL_MESSAGES.SOURCE_UNREADABLE
}

/**
 * Renders one image of the workbench, read through the owner-scoped attachment
 * or task-artifact endpoints. The bytes never come from a stored URL: the node
 * carries only the id reference, and the component re-reads them when the
 * reference changes.
 */
export function CanvasImageWorkbenchPreview(
  props: CanvasImageWorkbenchPreviewProps
) {
  const { t } = useTranslation()
  const node = props.node
  const source = node ? canvasImageToolSource(node.data) : null
  const key = sourceKey(source)
  const preview = props.preview?.trim() ?? ''
  const [state, setState] = useState<PreviewState>({ status: 'idle' })

  // Re-read only when the described source (or the transient run preview)
  // changes; an ordinary document edit creates a new node object but must not
  // download the same bytes again.
  useEffect(() => {
    if (preview) {
      setState({ status: 'ready', url: preview })
      return
    }
    if (!node || !source) {
      setState({ status: 'idle' })
      return
    }
    // The read path describes a node-owned source; the preview knows the node
    // it renders, so the reference carries its id like a workflow source does.
    const reference: CanvasWorkflowImageSource =
      source.kind === 'attachment'
        ? {
            nodeId: node.id,
            kind: 'attachment',
            sessionId: source.sessionId,
            attachmentId: source.attachmentId,
          }
        : {
            nodeId: node.id,
            kind: 'task-result',
            taskId: source.taskId,
            ...(source.artifactKey ? { artifactKey: source.artifactKey } : {}),
          }
    const controller = new AbortController()
    setState({ status: 'loading' })
    readCanvasWorkflowImage(reference, controller.signal)
      .then((url) => {
        if (!controller.signal.aborted) setState({ status: 'ready', url })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: previewErrorMessage(error) })
      })
    return () => controller.abort()
    // `key` is the source identity; the source object itself is rebuilt on
    // every render and must not restart the read.
  }, [key, preview])

  if (state.status === 'loading') {
    return (
      <div
        className={`text-muted-foreground flex items-center justify-center gap-2 text-sm ${props.className ?? ''}`}
      >
        <Spinner />
        {t('Loading image...')}
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <p
        className={`text-muted-foreground text-sm ${props.className ?? ''}`}
        role='status'
      >
        {translateServerText(t, state.message)}
      </p>
    )
  }
  if (state.status !== 'ready') return null
  return (
    <img
      alt={props.alt}
      className={`max-h-full max-w-full object-contain transition-transform ${props.className ?? ''}`}
      src={state.url}
      style={props.zoom ? { transform: `scale(${props.zoom})` } : undefined}
    />
  )
}
