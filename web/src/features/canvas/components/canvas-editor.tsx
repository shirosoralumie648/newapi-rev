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
import type { ReactNode } from 'react'
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
import {
  CANVAS_DROP_MESSAGES,
  CANVAS_EDIT_MESSAGES,
  CANVAS_NODE_ADD_BASE,
  CANVAS_NODE_ADD_OFFSET,
} from '../constants'
import {
  useCanvasAssistant,
  type CanvasAssistantMessage,
} from '../hooks/use-canvas-assistant'
import {
  useCanvasEditor,
  type CanvasAddedNode,
} from '../hooks/use-canvas-editor'
import { useCanvasImageTools } from '../hooks/use-canvas-image-tools'
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
import {
  canvasGenerationPrefillGraph,
  type CanvasArtifactTarget,
  type CanvasGenerationPrefill,
  type CanvasSourceTarget,
} from '../lib/canvas-navigation'
import {
  buildArtifactCanvasSeeds,
  buildAttachmentCanvasSeeds,
  type CanvasSendSeed,
} from '../lib/canvas-send'
import { canvasWorkflowMentions } from '../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasInspectorView,
  CanvasNodeKind,
  CanvasServerDocument,
  CanvasServerProject,
} from '../types'
import { CanvasArtifactBrowser } from './artifacts/canvas-artifact-browser'
import { CanvasAssetLibrary } from './assets/canvas-asset-library'
import { CanvasAssistantPanel } from './canvas-assistant-panel'
import { CanvasDropZone } from './canvas-drop-zone'
import { CanvasImageToolsDialog } from './canvas-image-tools-dialog'
import { CanvasInspectorViewToggle } from './canvas-inspector-view-toggle'
import { CanvasFlowNodeView, CanvasGroupNodeView } from './canvas-node'
import { CanvasNodeInspector } from './canvas-node-inspector'
import { CanvasRunBudgetDialog } from './canvas-run-budget-dialog'
import { CanvasToolbar } from './canvas-toolbar'
import type { CanvasToolbarInspectorView } from './canvas-toolbar'
import { CanvasGenerationPanel } from './generation/canvas-generation-panel'

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
  /** Owner scope the asset library and artifact browser list under. */
  userId: number | null
  /**
   * Generation prefill a conversation message action deep-linked: a prompt and
   * optionally the message's reference images. The editor turns it into a task
   * node graph exactly once.
   */
  generationPrefill?: CanvasGenerationPrefill | null
  /** Artifact a conversation creation or canvas deep link opens. */
  artifactTarget?: CanvasArtifactTarget | null
  /** Reports that the generation prefill was consumed, so it is not repeated. */
  onGenerationPrefillApplied?: () => void
  onChange: (document: CanvasServerDocument) => void
  onImportArchive: (file: File) => void
  /**
   * Persists pending edits before an archive export, so the server builds the
   * zip from the latest saved document.
   */
  onBeforeExportArchive?: () => Promise<void>
  onOpenSource?: (target: CanvasSourceTarget) => void
  /** Opens a conversation the artifact browser or library points back at. */
  onOpenConversation?: (sessionId: string) => void
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
  const [artifactSelection, setArtifactSelection] =
    useState<CanvasArtifactTarget | null>(props.artifactTarget ?? null)

  const imageTools = useCanvasImageTools({
    canvasId: props.project.id,
    group: workflowOptions.group,
    addLinkedNode: editor.addLinkedNode,
  })

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

  const imageToolMessage = imageTools.message
  const clearImageToolMessage = imageTools.clearMessage
  const notifyImageTool = useCallback(() => {
    if (!imageToolMessage) return
    toast.error(translateServerText(t, imageToolMessage))
    clearImageToolMessage()
  }, [clearImageToolMessage, imageToolMessage, t])
  useEffect(notifyImageTool, [notifyImageTool])

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

  const handleToggleInspectorView = useCallback(
    (view: CanvasToolbarInspectorView) => {
      setInspectorView((current) => (current === view ? 'details' : view))
    },
    []
  )

  const handleCloseInspector = useCallback(() => {
    editor.clearSelection()
    setInspectorView('details')
  }, [editor])

  // A generation prefill arrives from a conversation message action. The task
  // node carries the prompt and the message's reference images become attached
  // nodes, so the whole step runs (and settles) on the canvas side. The graph
  // is added once: the workspace clears the deep link right after.
  const generationPrefill = props.generationPrefill
  const generationPrefillApplied = props.onGenerationPrefillApplied
  const addGraph = editor.addGraph
  const selectNode = editor.selectNode
  const appliedPrefillRef = useRef(false)
  useEffect(() => {
    if (appliedPrefillRef.current || !generationPrefill) return
    appliedPrefillRef.current = true
    const graph = canvasGenerationPrefillGraph(
      generationPrefill,
      editor.nodes.length
    )
    const created = addGraph(graph.entries, graph.links)
    if (!created) {
      toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
    } else {
      selectNode(created[0] ?? null)
      toast.success(t('Generation step added to the canvas.'))
    }
    generationPrefillApplied?.()
  }, [
    addGraph,
    editor.nodes.length,
    generationPrefill,
    generationPrefillApplied,
    selectNode,
    t,
  ])

  // A deep link that points at one saved artifact opens the artifact browser
  // instead of the node details; it is re-opened only when the target changes.
  const artifactTarget = props.artifactTarget
  const appliedArtifactRef = useRef<string | null>(null)
  useEffect(() => {
    if (!artifactTarget) return
    setArtifactSelection(artifactTarget)
    if (appliedArtifactRef.current === artifactTarget.artifactId) return
    appliedArtifactRef.current = artifactTarget.artifactId
    setInspectorView('artifacts')
  }, [artifactTarget])

  const handleOpenArtifact = useCallback((target: CanvasSourceTarget) => {
    if (!target.artifactId) return
    setArtifactSelection({
      sessionId: target.sessionId,
      artifactId: target.artifactId,
    })
    setInspectorView('artifacts')
  }, [])

  /** Adds conversation/asset/library seeds to the current canvas. */
  const handleAddSeeds = useCallback(
    (seeds: CanvasSendSeed[]) => {
      const entries: CanvasAddedNode[] = seeds.map((seed, index) => {
        const { kind, ...data } = seed
        const cascade =
          CANVAS_NODE_ADD_OFFSET * ((editor.nodes.length + index) % 8)
        return {
          kind,
          position: {
            x: CANVAS_NODE_ADD_BASE + cascade,
            y: CANVAS_NODE_ADD_BASE + cascade,
          },
          data,
        }
      })
      if (entries.length === 0) return
      if (editor.addNodes(entries) < entries.length) {
        toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
      }
    },
    [editor, t]
  )

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
        await props.onBeforeExportArchive?.()
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
    [props.onBeforeExportArchive, props.project.id, t]
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

  let inspectorTitle = t('Node details')
  if (inspectorView === 'assistant') inspectorTitle = t('Assistant')
  else if (inspectorView === 'generate') inspectorTitle = t('Generate')
  else if (inspectorView === 'library') inspectorTitle = t('Asset library')
  else if (inspectorView === 'artifacts') inspectorTitle = t('Artifacts')

  let inspectorBody: ReactNode
  if (inspectorView === 'assistant') {
    inspectorBody = (
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
    )
  } else if (inspectorView === 'generate') {
    inspectorBody = (
      <CanvasGenerationPanel
        active
        disabled={props.disabled}
        group={workflowOptions.group}
        models={workflowOptions.models}
        onSendToCanvas={handleAddSeeds}
      />
    )
  } else if (inspectorView === 'library') {
    inspectorBody = (
      <CanvasAssetLibrary
        active
        onOpenConversation={(sessionId) =>
          props.onOpenConversation?.(sessionId)
        }
        onSendSeedsToCanvas={handleAddSeeds}
        onSendToCanvas={(asset) =>
          handleAddSeeds(
            asset.kind === 'attachment'
              ? buildAttachmentCanvasSeeds({
                  sessionId: asset.sessionId,
                  attachmentId: asset.id,
                  filename: asset.title || undefined,
                  mediaType: asset.mediaType,
                })
              : buildArtifactCanvasSeeds({
                  sessionId: asset.sessionId,
                  artifactId: asset.id,
                  title: asset.title,
                })
          )
        }
        userId={props.userId}
      />
    )
  } else if (inspectorView === 'artifacts') {
    inspectorBody = (
      <CanvasArtifactBrowser
        active
        initialArtifactId={artifactSelection?.artifactId}
        initialSessionId={artifactSelection?.sessionId}
        onAddToCanvas={(artifact) =>
          handleAddSeeds(
            buildArtifactCanvasSeeds({
              sessionId: artifact.session_id,
              artifactId: artifact.id,
              title: artifact.title,
            })
          )
        }
        onClose={handleCloseInspector}
        userId={props.userId}
      />
    )
  } else {
    inspectorBody = (
      <CanvasNodeInspector
        disabled={props.disabled}
        groups={workflowOptions.groups}
        mentions={mentions}
        models={workflowOptions.models}
        node={editor.selectedNode}
        onDelete={editor.deleteNode}
        onOpenImageTools={imageTools.open}
        onOpenArtifact={handleOpenArtifact}
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
    )
  }

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
      {inspectorBody}
    </div>
  )

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden'>
      <WorkspaceInspector
        open={
          isMobile
            ? inspectorView !== 'details' || editor.selectedNode !== null
            : true
        }
        onClose={handleCloseInspector}
        title={inspectorTitle}
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
                    inspectorView={inspectorView}
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
                    onToggleInspectorView={handleToggleInspectorView}
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
      <CanvasImageToolsDialog
        busy={imageTools.busy}
        disabled={props.disabled}
        models={workflowOptions.models}
        onClose={imageTools.close}
        onCrop={imageTools.crop}
        onRedraw={imageTools.redraw}
        onUpscale={imageTools.upscale}
        source={imageTools.source}
        sourceSize={imageTools.sourceSize}
        tool={imageTools.tool}
      />

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
