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
import { MiniMap, type NodeTypes, type Viewport } from '@xyflow/react'
import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Canvas } from '@/components/ai-elements/canvas'
import { Panel } from '@/components/ai-elements/panel'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'

import { useCanvasEditor } from '../hooks/use-canvas-editor'
import {
  CANVAS_ERRORS,
  parseCanvasImport,
  serializeCanvasExport,
  toServerDocument,
  validateCanvasDocument,
} from '../lib/canvas-document'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeKind,
  CanvasServerDocument,
  CanvasServerProject,
} from '../types'
import { CanvasFlowNodeView } from './canvas-node'
import { CanvasNodeInspector } from './canvas-node-inspector'
import { CanvasToolbar } from './canvas-toolbar'

const canvasNodeTypes: NodeTypes = {
  text: CanvasFlowNodeView,
  prompt: CanvasFlowNodeView,
  image: CanvasFlowNodeView,
  artifact: CanvasFlowNodeView,
  message: CanvasFlowNodeView,
  task: CanvasFlowNodeView,
}

interface CanvasEditorProps {
  project: CanvasServerProject
  disabled?: boolean
  onChange: (document: CanvasServerDocument) => void
}

export function CanvasEditor(props: CanvasEditorProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const viewportRef = useRef<Viewport | undefined>(props.project.document.viewport)

  const handleChange = useCallback(
    (nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]) => {
      const canvasDocument = toServerDocument(nodes, edges, viewportRef.current)
      const limitError = validateCanvasDocument(canvasDocument)
      if (limitError) {
        toast.error(t(limitError))
        return
      }
      props.onChange(canvasDocument)
    },
    [props.onChange, t]
  )

  const editor = useCanvasEditor(props.project.document, handleChange)

  const handleMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      viewportRef.current = viewport
    },
    []
  )

  const handleAddNode = useCallback(
    (kind: CanvasNodeKind) => {
      if (!editor.addNode(kind)) {
        toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
      }
    },
    [editor, t]
  )

  const handleExport = useCallback(() => {
    const canvasDocument = toServerDocument(
      editor.nodes,
      editor.edges,
      viewportRef.current
    )
    const text = serializeCanvasExport(
      props.project.title,
      canvasDocument
    )
    const url = URL.createObjectURL(
      new Blob([text], { type: 'application/json' })
    )
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${props.project.title || 'canvas'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [editor.edges, editor.nodes, props.project.title])

  const handleImportFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text()
        const imported = parseCanvasImport(text)
        editor.replaceDocument(imported.document)
        toast.success(t('Canvas imported.'))
      } catch (error) {
        toast.error(
          t(error instanceof Error ? error.message : CANVAS_ERRORS.INVALID_FILE)
        )
      }
    },
    [editor, t]
  )

  const inspector = (
    <CanvasNodeInspector
      disabled={props.disabled}
      node={editor.selectedNode}
      onDelete={editor.deleteNode}
      onUpdateData={editor.updateNodeData}
    />
  )

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden'>
      <div className='relative min-h-0 min-w-0 flex-1'>
        <Canvas
          defaultViewport={props.project.document.viewport}
          edges={editor.edges}
          fitView={!props.project.document.viewport}
          nodeTypes={canvasNodeTypes}
          nodes={editor.nodes}
          onConnect={editor.handleConnect}
          onEdgesChange={editor.handleEdgesChange}
          onMoveEnd={handleMoveEnd}
          onNodesChange={editor.handleNodesChange}
        >
          <Panel position='top-left'>
            <CanvasToolbar
              canRedo={editor.canRedo}
              canUndo={editor.canUndo}
              disabled={props.disabled}
              onAddNode={handleAddNode}
              onExport={handleExport}
              onImportFile={handleImportFile}
              onRedo={editor.redo}
              onUndo={editor.undo}
            />
          </Panel>
          <MiniMap
            className='bg-card!'
            pannable
            zoomable
          />
        </Canvas>
      </div>

      {!isMobile && (
        <aside className='bg-muted/10 flex w-72 shrink-0 flex-col overflow-hidden border-l'>
          {inspector}
        </aside>
      )}

      {isMobile && (
        <Sheet
          onOpenChange={(open) => {
            if (!open) editor.clearSelection()
          }}
          open={editor.selectedNode !== null}
        >
          <SheetContent className='w-full gap-0 p-0 sm:max-w-md' side='right'>
            <SheetHeader className='sr-only'>
              <SheetTitle>{t('Node details')}</SheetTitle>
            </SheetHeader>
            {inspector}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
