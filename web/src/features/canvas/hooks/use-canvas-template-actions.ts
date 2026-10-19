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
import { useCallback } from 'react'

import { uploadPlaygroundAttachmentDirect } from '@/features/playground/lib/attachment-upload'

import {
  createCanvasProject,
  deleteCanvasProject,
  getCanvasTemplateAssetBlob,
  updateCanvasProject,
} from '../api'
import type { CanvasAddedNode } from './use-canvas-editor'
import {
  CANVAS_TEMPLATE_ERRORS,
  canvasTemplateAssetSource,
  canvasTemplateMaterialization,
  canvasTemplateOffset,
  canvasTemplateReferencedAttachments,
} from '../lib/canvas-template'
import type { CanvasFlowNode, CanvasTemplateDetail } from '../types'

interface CanvasTemplateActionsOptions {
  projectId: string
  nodes: CanvasFlowNode[]
  addGraph: (
    entries: CanvasAddedNode[],
    links: { source: number; target: number }[]
  ) => string[] | null
  selectNode: (nodeId: string | null) => void
  onOpenProject: (projectId: string) => void
}

async function uploadTemplateAssets(
  template: CanvasTemplateDetail,
  canvasId: string
): Promise<Record<string, string>> {
  const referenced = canvasTemplateReferencedAttachments(template.document)
  const uploaded: Record<string, string> = {}
  for (const asset of template.assets) {
    const source = canvasTemplateAssetSource(asset)
    if (!referenced.has(source) || uploaded[source]) continue
    const blob = await getCanvasTemplateAssetBlob(template.id, asset.id)
    const file = new File([blob], asset.filename || 'attachment', {
      type: asset.mediaType,
    })
    const attachment = await uploadPlaygroundAttachmentDirect(
      { canvasId },
      file
    )
    uploaded[source] = attachment.id
  }
  return uploaded
}

/**
 * Applies stored templates to the workspace. Both paths re-upload the inline
 * assets into the target canvas partition first, so the saved document never
 * keeps another account's attachment ids; the graph and the created document
 * then receive fresh node ids and remapped group links.
 */
export function useCanvasTemplateActions(
  options: CanvasTemplateActionsOptions
) {
  const { addGraph, nodes, onOpenProject, projectId, selectNode } = options

  const applyToCurrent = useCallback(
    async (template: CanvasTemplateDetail) => {
      const uploaded = await uploadTemplateAssets(template, projectId)
      const materialized = canvasTemplateMaterialization(
        template.document,
        uploaded,
        projectId,
        canvasTemplateOffset(nodes, template.document)
      )
      if (materialized.entries.length === 0) {
        throw new Error(CANVAS_TEMPLATE_ERRORS.EMPTY)
      }
      const created = addGraph(materialized.entries, materialized.links)
      if (!created) {
        throw new Error(CANVAS_TEMPLATE_ERRORS.FULL)
      }
      selectNode(created[0] ?? null)
      return { droppedRefs: materialized.droppedRefs }
    },
    [addGraph, nodes, projectId, selectNode]
  )

  const createFromTemplate = useCallback(
    async (template: CanvasTemplateDetail) => {
      const project = await createCanvasProject({
        title: template.name,
        document: { nodes: [], edges: [] },
      })
      try {
        const uploaded = await uploadTemplateAssets(template, project.id)
        const materialized = canvasTemplateMaterialization(
          template.document,
          uploaded,
          project.id
        )
        if (materialized.entries.length === 0) {
          throw new Error(CANVAS_TEMPLATE_ERRORS.EMPTY)
        }
        await updateCanvasProject(project.id, {
          revision: project.revision,
          document: materialized.document,
        })
        onOpenProject(project.id)
        return { droppedRefs: materialized.droppedRefs }
      } catch (error) {
        await deleteCanvasProject(project.id).catch(() => undefined)
        throw error
      }
    },
    [onOpenProject]
  )

  return { applyToCurrent, createFromTemplate }
}
