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
import {
  MiniMap,
  ReactFlowProvider,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Canvas } from '@/components/ai-elements/canvas'
import { Panel } from '@/components/ai-elements/panel'
import { WorkspaceInspector } from '@/components/workspace-inspector'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  getServerMessage,
  translateServerText,
} from '@/lib/server-error-message'

import { CANVAS_DROP_MESSAGES, CANVAS_EDIT_MESSAGES } from '../constants'
import {
  useCanvasEditor,
  type CanvasAddedNode,
} from '../hooks/use-canvas-editor'
import { useCanvasWorkflowOptions } from '../hooks/use-canvas-workflow-options'
import { useCanvasWorkflowRunner } from '../hooks/use-canvas-workflow-runner'
import {
  CANVAS_ERRORS,
  parseCanvasImport,
  serializeCanvasExport,
  toServerDocument,
  validateCanvasDocument,
} from '../lib/canvas-document'
import { CanvasDropError, canvasDropEntries } from '../lib/canvas-drop'
import type { CanvasSourceTarget } from '../lib/canvas-navigation'
import { canvasWorkflowMentions } from '../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeKind,
  CanvasServerDocument,
  CanvasServerProject,
} from '../types'
import { CanvasDropZone } from './canvas-drop-zone'
import { CanvasFlowNodeView, CanvasGroupNodeView } from './canvas-node'
import { CanvasNodeInspector } from './canvas-node-inspector'
import { CanvasToolbar } from './canvas-toolbar'

const canvasNodeTypes: NodeTypes = {
  text: CanvasFlowNodeView,
  note: CanvasFlowNodeView,
  prompt: CanvasFlowNodeView,
  image: CanvasFlowNodeView,
  attachment: CanvasFlowNodeView,
  artifact: CanvasFlowNodeView,
  message: CanvasFlowNodeView,
  model: CanvasFlowNodeView,
  task: CanvasFlowNodeView,
  'task-result': CanvasFlowNodeView,
  video: CanvasFlowNodeView,
  audio: CanvasFlowNodeView,
  group: CanvasGroupNodeView,
}

interface CanvasEditorProps {
  project: CanvasServerProject
  disabled?: boolean
  onChange: (document: CanvasServerDocument) => void
  onOpenSource?: (target: CanvasSourceTarget) => void
}

export function CanvasEditor(props: CanvasEditorProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const viewportRef = useRef<Viewport | undefined>(
    props.project.document.viewport
  )
  const workflowOptions = useCanvasWorkflowOptions()

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

  const editor = useCanvasEditor(props.project.document, handleChange, {
    shortcutsEnabled: !props.disabled,
    onRejectedConnection: (messageKey) => toast.error(t(messageKey)),
  })

  const workflow = useCanvasWorkflowRunner({
    nodes: editor.nodes,
    edges: editor.edges,
    group: workflowOptions.group,
    updateNodeData: editor.updateNodeData,
    addLinkedNode: editor.addLinkedNode,
  })

  // The mention menu of the selected step offers only its connected nodes, so
  // an instruction can never reference a resource the step does not consume.
  const selectedNode = editor.selectedNode
  const mentions = useMemo(
    () =>
      selectedNode
        ? canvasWorkflowMentions(selectedNode, editor.nodes, editor.edges)
        : [],
    [editor.edges, editor.nodes, selectedNode]
  )
  const workflowMessage = workflow.message
  const clearWorkflowMessage = workflow.clearMessage

  const notifyWorkflow = useCallback(() => {
    if (!workflowMessage) return
    toast.error(translateServerText(t, workflowMessage))
    clearWorkflowMessage()
  }, [clearWorkflowMessage, t, workflowMessage])
  useEffect(notifyWorkflow, [notifyWorkflow])

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

  const handlePaste = useCallback(() => {
    if (!editor.pasteSelection()) {
      toast.error(t(CANVAS_EDIT_MESSAGES.PASTE_NO_ROOM))
    }
  }, [editor, t])

  const handleDropFiles = useCallback(
    async (files: File[], position: { x: number; y: number }) => {
      if (props.disabled) return
      let entries: CanvasAddedNode[]
      try {
        entries = await canvasDropEntries(props.project.id, position, files)
      } catch (error) {
        const message =
          error instanceof CanvasDropError
            ? error.messageKey
            : (getServerMessage(error) ?? CANVAS_DROP_MESSAGES.UPLOAD_FAILED)
        toast.error(translateServerText(t, message))
        return
      }
      if (editor.addNodes(entries) < entries.length) {
        toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
      }
    },
    [editor, props.disabled, props.project.id, t]
  )

  const handleExport = useCallback(() => {
    const canvasDocument = toServerDocument(
      editor.nodes,
      editor.edges,
      viewportRef.current
    )
    const text = serializeCanvasExport(props.project.title, canvasDocument)
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
    <div className='bg-muted/10 flex h-full min-h-0 w-full flex-col overflow-hidden border-l'>
      <CanvasNodeInspector
        disabled={props.disabled}
        groups={workflowOptions.groups}
        mentions={mentions}
        models={workflowOptions.models}
        node={editor.selectedNode}
        onDelete={editor.deleteNode}
        onOpenSource={props.onOpenSource}
        onRetry={workflow.retry}
        onUpdateData={editor.updateNodeData}
        previews={
          editor.selectedNode
            ? (workflow.results[editor.selectedNode.id] ?? [])
            : []
        }
        runPhase={workflow.phase}
      />
    </div>
  )

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden'>
      <WorkspaceInspector
        open={isMobile ? editor.selectedNode !== null : true}
        onClose={editor.clearSelection}
        title={t('Node details')}
        main={
          <ReactFlowProvider>
            <CanvasDropZone
              disabled={props.disabled}
              onDropFiles={(files, position) =>
                void handleDropFiles(files, position)
              }
            >
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
                    canCopy={editor.selectedCount > 0}
                    canGroup={editor.canGroup}
                    canPaste={editor.hasClipboard}
                    canRedo={editor.canRedo}
                    canSelectAll={editor.nodes.length > 0}
                    canUndo={editor.canUndo}
                    canUngroup={editor.canUngroup}
                    disabled={props.disabled}
                    group={workflowOptions.group}
                    groups={workflowOptions.groups}
                    onAddNode={handleAddNode}
                    onCancelRun={() => void workflow.cancel()}
                    onCopy={() => void editor.copySelection()}
                    onExport={handleExport}
                    onGroupChange={workflowOptions.setGroup}
                    onGroupSelection={() => void editor.groupSelection()}
                    onImportFile={handleImportFile}
                    onPaste={handlePaste}
                    onRedo={editor.redo}
                    onRunWorkflow={() => workflow.run()}
                    onSelectAll={editor.selectAll}
                    onUndo={editor.undo}
                    onUngroupSelection={() => void editor.ungroupSelection()}
                    runPhase={workflow.phase}
                  />
                </Panel>
                <MiniMap className='bg-card!' pannable zoomable />
              </Canvas>
            </CanvasDropZone>
          </ReactFlowProvider>
        }
        panelDefaultSize='30'
        panelMinSize='22'
      >
        {inspector}
      </WorkspaceInspector>
    </div>
  )
}
