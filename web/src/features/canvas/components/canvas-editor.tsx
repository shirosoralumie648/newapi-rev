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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

import { exportCanvasArchive } from '../api'
import { CANVAS_DROP_MESSAGES, CANVAS_EDIT_MESSAGES } from '../constants'
import {
  useCanvasAssistant,
  type CanvasAssistantMessage,
} from '../hooks/use-canvas-assistant'
import {
  useCanvasEditor,
  type CanvasAddedNode,
} from '../hooks/use-canvas-editor'
import { useCanvasWorkflowOptions } from '../hooks/use-canvas-workflow-options'
import { useCanvasWorkflowRunner } from '../hooks/use-canvas-workflow-runner'
import type {
  CanvasWorkflowRunBudgetRef,
  CanvasWorkflowRunPlan,
} from '../hooks/use-canvas-workflow-runner'
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
  CanvasInspectorView,
  CanvasNodeKind,
  CanvasServerDocument,
  CanvasServerProject,
} from '../types'
import { CanvasAssistantPanel } from './canvas-assistant-panel'
import { CanvasDropZone } from './canvas-drop-zone'
import { CanvasInspectorViewToggle } from './canvas-inspector-view-toggle'
import { CanvasFlowNodeView, CanvasGroupNodeView } from './canvas-node'
import { CanvasNodeInspector } from './canvas-node-inspector'
import { CanvasRunBudgetDialog } from './canvas-run-budget-dialog'
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
  onImportArchive: (file: File) => void
  onOpenSource?: (target: CanvasSourceTarget) => void
}

/** Saves one generated canvas file through a transient object URL. */
function downloadCanvasFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
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

  // The validated run the run-budget dialog is confirming; the dialog opens
  // only when the same click would also start a run.
  const [runPlan, setRunPlan] = useState<CanvasWorkflowRunPlan | null>(null)

  const [inspectorView, setInspectorView] =
    useState<CanvasInspectorView>('details')

  const assistant = useCanvasAssistant({
    nodes: editor.nodes,
    edges: editor.edges,
    anchorNode: editor.selectedNode,
    group: workflowOptions.group,
    models: workflowOptions.models,
    addLinkedNode: editor.addLinkedNode,
    addNodes: editor.addNodes,
    runWorkflow: workflow.run,
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

  const assistantMessage = assistant.message
  const clearAssistantMessage = assistant.clearMessage
  const notifyAssistant = useCallback(() => {
    if (!assistantMessage) return
    toast.error(translateServerText(t, assistantMessage))
    clearAssistantMessage()
  }, [assistantMessage, clearAssistantMessage, t])
  useEffect(notifyAssistant, [notifyAssistant])

  const handleInsertAssistantReply = useCallback(
    (message: CanvasAssistantMessage) => {
      if (assistant.insertReply(message.content)) {
        toast.success(t('Added the reply to the canvas.'))
      }
    },
    [assistant, t]
  )

  const handleGenerateAssistantReply = useCallback(
    (message: CanvasAssistantMessage) => {
      assistant.generate(message.content)
    },
    [assistant]
  )

  const handleToggleAssistant = useCallback(() => {
    setInspectorView((view) => (view === 'assistant' ? 'details' : 'assistant'))
  }, [])

  const handleCloseInspector = useCallback(() => {
    editor.clearSelection()
    setInspectorView('details')
  }, [editor])

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
    downloadCanvasFile(
      `${props.project.title || 'canvas'}.json`,
      new Blob([text], { type: 'application/json' })
    )
  }, [editor.edges, editor.nodes, props.project.title])

  const handleExportArchive = useCallback(
    async (nodeIds?: string[]) => {
      try {
        const archive = await exportCanvasArchive(props.project.id, nodeIds)
        downloadCanvasFile(archive.filename, archive.blob)
      } catch (error) {
        toast.error(
          translateServerText(
            t,
            getServerMessage(error) ?? CANVAS_ERRORS.ARCHIVE_EXPORT_FAILED
          )
        )
      }
    },
    [props.project.id, t]
  )

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
      {isMobile ? (
        <div className='shrink-0 border-b p-2'>
          <CanvasInspectorViewToggle
            onViewChange={setInspectorView}
            view={inspectorView}
          />
        </div>
      ) : null}
      {inspectorView === 'assistant' ? (
        <CanvasAssistantPanel
          anchorLabel={assistant.anchorLabel}
          canGenerate={assistant.canGenerate}
          contextCount={assistant.contextCount}
          disabled={props.disabled}
          messages={assistant.messages}
          mode={assistant.mode}
          model={assistant.model}
          models={workflowOptions.models}
          onGenerate={handleGenerateAssistantReply}
          onInsertReply={handleInsertAssistantReply}
          onModeChange={assistant.setMode}
          onModelChange={assistant.setModel}
          onSend={assistant.send}
          onStop={assistant.stop}
          streaming={assistant.streaming}
          workflowPhase={workflow.phase}
        />
      ) : (
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
      )}
    </div>
  )

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden'>
      <WorkspaceInspector
        open={
          isMobile
            ? inspectorView === 'assistant' || editor.selectedNode !== null
            : true
        }
        onClose={handleCloseInspector}
        title={
          inspectorView === 'assistant' ? t('Assistant') : t('Node details')
        }
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
                    assistantOpen={inspectorView === 'assistant'}
                    canCopy={editor.selectedCount > 0}
                    canExportSelection={editor.selectedCount > 0}
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
                    onExportArchive={() => void handleExportArchive()}
                    onExportSelectionArchive={() =>
                      void handleExportArchive(
                        editor.nodes
                          .filter((node) => node.selected === true)
                          .map((node) => node.id)
                      )
                    }
                    onGroupChange={workflowOptions.setGroup}
                    onGroupSelection={() => void editor.groupSelection()}
                    onImportArchiveFile={(file) => props.onImportArchive(file)}
                    onImportFile={handleImportFile}
                    onPaste={handlePaste}
                    onRedo={editor.redo}
                    onRunWorkflow={() => setRunPlan(workflow.estimate())}
                    onSelectAll={editor.selectAll}
                    onToggleAssistant={handleToggleAssistant}
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
      <CanvasRunBudgetDialog
        group={workflowOptions.group}
        onOpenChange={(open) => {
          if (!open) setRunPlan(null)
        }}
        onRun={(budget?: CanvasWorkflowRunBudgetRef) => {
          setRunPlan(null)
          workflow.run(undefined, budget)
        }}
        open={runPlan !== null}
        steps={runPlan?.steps ?? []}
      />
    </div>
  )
}
