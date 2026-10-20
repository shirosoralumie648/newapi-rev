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
import { nanoid } from 'nanoid'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { uploadPlaygroundAttachmentDirect } from '@/features/playground/lib/attachment-upload'

import {
  createCanvasProject,
  deleteCanvasProject,
  updateCanvasProject,
} from '../api'
import { CANVAS_LINKED_NODE_OFFSET_X, CANVAS_NODE_ADD_BASE } from '../constants'
import type { CanvasServerDocument } from '../types'

interface CanvasVideoFrameActionsOptions {
  /** Title of the video project the frame was captured from. */
  sourceTitle: string
  /** Opens the freshly created image project in the workspace. */
  onOpenProject: (projectId: string) => void | Promise<void>
}

/**
 * Turns a captured video frame into an image workbench project. The frame is
 * re-uploaded into the new project's own attachment partition, so the saved
 * document only names resources of that project and deleting the source video
 * canvas cannot break the handoff. A half-created project is removed when the
 * upload or the document write fails.
 */
export function useCanvasVideoFrameActions(
  options: CanvasVideoFrameActionsOptions
) {
  const { t } = useTranslation()
  const { onOpenProject, sourceTitle } = options

  const createImageWorkbenchFromFrame = useCallback(
    async (file: File): Promise<string> => {
      const suffix = t('Frame')
      const title = Array.from(
        [sourceTitle.trim(), suffix].filter(Boolean).join(' · ')
      )
        .slice(0, 200)
        .join('')
      const project = await createCanvasProject({
        clientId: nanoid(),
        title,
        mode: 'image',
        document: { nodes: [], edges: [] },
      })
      try {
        const attachment = await uploadPlaygroundAttachmentDirect(
          { canvasId: project.id },
          file
        )
        // The workbench is organized around a generation step, so the frame
        // lands as the connected reference image of a fresh image step.
        // Opening the project shows that step with the frame in its reference
        // strip, ready for an img2img or video-edit chain.
        const frameNodeId = nanoid()
        const stepNodeId = nanoid()
        const document: CanvasServerDocument = {
          nodes: [
            {
              id: frameNodeId,
              type: 'image',
              position: {
                x: CANVAS_NODE_ADD_BASE,
                y: CANVAS_NODE_ADD_BASE,
              },
              data: {
                kind: 'image',
                label: attachment.filename,
                mediaType: attachment.mediaType,
                ref: {
                  sessionId: attachment.sessionId,
                  attachmentId: attachment.id,
                },
              },
            },
            {
              id: stepNodeId,
              type: 'task',
              position: {
                x: CANVAS_NODE_ADD_BASE + CANVAS_LINKED_NODE_OFFSET_X,
                y: CANVAS_NODE_ADD_BASE,
              },
              data: {
                kind: 'task',
                workflow: { generation: 'image' },
              },
            },
          ],
          edges: [
            {
              id: nanoid(),
              source: frameNodeId,
              target: stepNodeId,
            },
          ],
        }
        await updateCanvasProject(project.id, {
          revision: project.revision,
          document,
        })
        await onOpenProject(project.id)
        return project.id
      } catch (error) {
        await deleteCanvasProject(project.id).catch(() => undefined)
        throw error
      }
    },
    [onOpenProject, sourceTitle, t]
  )

  return { createImageWorkbenchFromFrame }
}
