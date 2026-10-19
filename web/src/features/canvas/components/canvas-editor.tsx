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
  type EdgeTypes,
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
import { uploadPlaygroundAttachmentDirect } from '@/features/playground/lib/attachment-upload'
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
  CANVAS_NODE_KIND_LABELS,
  CANVAS_PNG_EXPORT_MESSAGES,
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
import { useCanvasTemplateActions } from '../hooks/use-canvas-template-actions'
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
  CanvasPngExportError,
  renderCanvasPng,
  type CanvasPngExportResult,
  type CanvasPngExportScope,
} from '../lib/canvas-export'
import { canvasImageToolModels } from '../lib/canvas-image-tools'
import {
  canvasGenerationPrefillGraph,
  type CanvasArtifactTarget,
  type CanvasGenerationPrefill,
  type CanvasSourceTarget,
} from '../lib/canvas-navigation'
import { isCanvasNodeSearchShortcut } from '../lib/canvas-organization'
import {
  buildArtifactCanvasSeeds,
  buildAttachmentCanvasSeeds,
  type CanvasSendSeed,
} from '../lib/canvas-send'
import {
  canvasWorkflowIsPreferredResult,
  canvasWorkflowMentions,
} from '../lib/canvas-workflow'
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
import { CanvasAlignmentGuides } from './canvas-alignment-guides'
import { CanvasAssistantPanel } from './canvas-assistant-panel'
import { CanvasDropZone } from './canvas-drop-zone'
import { CanvasFlowEdgeView } from './canvas-edge'
import { CanvasImageToolsDialog } from './canvas-image-tools-dialog'
import { CanvasInspectorViewToggle } from './canvas-inspector-view-toggle'
import { CanvasFlowNodeView, CanvasGroupNodeView } from './canvas-node'
import { CanvasNodeInspector } from './canvas-node-inspector'
import { CanvasNodeSearch } from './canvas-node-search'
import { CanvasPngExportDialog } from './canvas-png-export-dialog'
import { CanvasRunBudgetDialog } from './canvas-run-budget-dialog'
import { CanvasTemplateLibraryDialog } from './canvas-template-library-dialog'
import { CanvasToolbar } from './canvas-toolbar'
import type { CanvasToolbarInspectorView } from './canvas-toolbar'
import { CanvasViewportControls } from './canvas-viewport-controls'
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

// `toServerDocument` persists only server-known edge fields, so the custom edge
// keeps its interactions local (delete through xyflow) instead of storing data.
const canvasEdgeTypes: EdgeTypes = {
  default: CanvasFlowEdgeView,
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
  /** Switches the workspace to a canvas created from a template. */
  onOpenProject: (projectId: string) => void
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

  const templateActions = useCanvasTemplateActions({
    projectId: props.project.id,
    nodes: editor.nodes,
    addGraph: editor.addGraph,
    selectNode: editor.selectNode,
    onOpenProject: props.onOpenProject,
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
  const [templatesOpen, setTemplatesOpen] = useState(false)

  // The in-canvas node search panel. Cmd/Ctrl+P is the keyboard entry, the
  // toolbar button is the discoverable one; both open the same panel.
  const [nodeSearchOpen, setNodeSearchOpen] = useState(false)
  const handleNodeSearchOpenChange = useCallback((open: boolean) => {
    setNodeSearchOpen(open)
  }, [])
  const disabled = props.disabled
  useEffect(() => {
    if (disabled) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isCanvasNodeSearchShortcut(event)) return
      event.preventDefault()
      setNodeSearchOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [disabled])

  const [inspectorView, setInspectorView] =
    useState<CanvasInspectorView>('details')
  const [artifactSelection, setArtifactSelection] =
    useState<CanvasArtifactTarget | null>(props.artifactTarget ?? null)

  const [pngExport, setPngExport] = useState<CanvasPngExportResult | null>(null)
  const [pngBusy, setPngBusy] = useState(false)
  const [pngSaving, setPngSaving] = useState(false)
  const [pngSaved, setPngSaved] = useState(false)

  const imageTools = useCanvasImageTools({
    canvasId: props.project.id,
    group: workflowOptions.group,
    modelCapabilities: workflowOptions.modelCapabilities,
    addLinkedNode: editor.addLinkedNode,
  })

  // A dialog only lists models that advertise the tool. Unknown catalog
  // metadata leaves the full list intact, matching the workflow controls.
  const imageToolModels = useMemo(
    () =>
      imageTools.tool
        ? canvasImageToolModels(
            workflowOptions.models,
            workflowOptions.modelCapabilities,
            imageTools.tool
          )
        : workflowOptions.models,
    [imageTools.tool, workflowOptions.modelCapabilities, workflowOptions.models]
  )

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

  const handleExportPng = useCallback(
    async (scope: CanvasPngExportScope) => {
      setPngBusy(true)
      try {
        const kindLabels = Object.fromEntries(
          Object.entries(CANVAS_NODE_KIND_LABELS).map(([kind, labelKey]) => [
            kind,
            t(labelKey),
          ])
        )
        const result = await renderCanvasPng(
          editor.nodes,
          editor.edges,
          scope,
          props.project.title,
          {
            theme: document.documentElement.classList.contains('dark')
              ? 'dark'
              : 'light',
            kindLabels,
          }
        )
        setPngExport(result)
        setPngSaved(false)
      } catch (error) {
        toast.error(
          t(
            error instanceof CanvasPngExportError
              ? error.message
              : CANVAS_PNG_EXPORT_MESSAGES.FAILED
          )
        )
      } finally {
        setPngBusy(false)
      }
    },
    [editor.edges, editor.nodes, props.project.title, t]
  )

  const handleDownloadPng = useCallback(() => {
    if (!pngExport) return
    downloadCanvasFile(pngExport.filename, pngExport.blob)
  }, [pngExport])

  const handleSavePng = useCallback(async () => {
    if (!pngExport || pngSaving) return
    setPngSaving(true)
    try {
      await uploadPlaygroundAttachmentDirect(
        { canvasId: props.project.id },
        new File([pngExport.blob], pngExport.filename, { type: 'image/png' })
      )
      setPngSaved(true)
      toast.success(t('PNG saved to the library.'))
    } catch (error) {
      toast.error(
        translateServerText(
          t,
          getServerMessage(error) ?? CANVAS_PNG_EXPORT_MESSAGES.SAVE_FAILED
        )
      )
    } finally {
      setPngSaving(false)
    }
  }, [pngExport, pngSaving, props.project.id, t])

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

  const selectedResultSourceId =
    editor.selectedNode?.data.workflow?.sourceNodeId?.trim() ?? ''
  const selectedResultSiblingCount = selectedResultSourceId
    ? editor.nodes.filter(
        (node) =>
          node.data.workflow?.sourceNodeId?.trim() === selectedResultSourceId
      ).length
    : 0

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
        modelCapabilities={workflowOptions.modelCapabilities}
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
        canPreferResult={selectedResultSiblingCount > 1}
        disabled={props.disabled}
        groups={workflowOptions.groups}
        mentions={mentions}
        modelCapabilities={workflowOptions.modelCapabilities}
        models={workflowOptions.models}
        node={editor.selectedNode}
        onDelete={editor.deleteNode}
        onOpenImageTools={imageTools.open}
        onOpenArtifact={handleOpenArtifact}
        onOpenSource={props.onOpenSource}
        onPreferResult={editor.setWorkflowPreferredResult}
        onRetry={workflow.retry}
        onUpdateData={editor.updateNodeData}
        preferredResult={
          editor.selectedNode
            ? canvasWorkflowIsPreferredResult(editor.selectedNode, editor.nodes)
            : false
        }
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
                deleteKeyCode={null}
                edgeTypes={canvasEdgeTypes}
                edges={editor.edges}
                fitView={!props.project.document.viewport}
                nodeTypes={canvasNodeTypes}
                nodes={editor.nodes}
                onConnect={editor.handleConnect}
                onEdgesChange={editor.handleEdgesChange}
                onMoveEnd={handleMoveEnd}
                onNodeDrag={editor.handleNodeDrag}
                onNodeDragStart={editor.handleNodeDragStart}
                onNodeDragStop={editor.handleNodeDragStop}
                onNodesChange={editor.handleNodesChange}
                onReconnect={(edge, connection) =>
                  editor.handleReconnect(edge as CanvasFlowEdge, connection)
                }
                showControls={false}
              >
                <CanvasAlignmentGuides guides={editor.alignmentGuides} />
                <Panel position='top-left'>
                  <CanvasToolbar
                    canCopy={editor.selectedCount > 0}
                    canDistribute={editor.canDistribute}
                    canExportSelection={editor.selectedCount > 0}
                    canGroup={editor.canGroup}
                    canPaste={editor.hasClipboard}
                    canRedo={editor.canRedo}
                    canRunSelection={
                      editor.selectedCount > 0 && workflow.phase !== 'running'
                    }
                    canSelectAll={editor.nodes.length > 0}
                    canUngroup={editor.canUngroup}
                    canUndo={editor.canUndo}
                    disabled={props.disabled}
                    exportingPng={pngBusy}
                    group={workflowOptions.group}
                    groups={workflowOptions.groups}
                    inspectorView={inspectorView}
                    onAddNode={handleAddNode}
                    onCancelRun={() => void workflow.cancel()}
                    onCopy={() => void editor.copySelection()}
                    onDistributeHorizontal={() =>
                      editor.distributeSelection('horizontal')
                    }
                    onDistributeVertical={() =>
                      editor.distributeSelection('vertical')
                    }
                    onExport={handleExport}
                    onExportArchive={() => void handleExportArchive()}
                    onExportPng={() => void handleExportPng('canvas')}
                    onExportSelectionArchive={() =>
                      void handleExportArchive(
                        editor.nodes
                          .filter((node) => node.selected === true)
                          .map((node) => node.id)
                      )
                    }
                    onExportSelectionPng={() =>
                      void handleExportPng('selection')
                    }
                    onGroupChange={workflowOptions.setGroup}
                    onOpenTemplates={() => setTemplatesOpen(true)}
                    onGroupSelection={() => void editor.groupSelection()}
                    onImportArchiveFile={(file) => props.onImportArchive(file)}
                    onImportFile={handleImportFile}
                    onPaste={handlePaste}
                    onRedo={editor.redo}
                    onRunWorkflow={() => setRunPlan(workflow.estimate())}
                    onRunSelection={() =>
                      setRunPlan(workflow.estimateSelection())
                    }
                    onSearchNodes={() => setNodeSearchOpen(true)}
                    onSelectAll={editor.selectAll}
                    onToggleInspectorView={handleToggleInspectorView}
                    onUndo={editor.undo}
                    onUngroupSelection={() => void editor.ungroupSelection()}
                    runPhase={workflow.phase}
                  />
                </Panel>
                <Panel position='bottom-left'>
                  <div className='bg-card rounded-md border shadow-sm'>
                    <CanvasViewportControls />
                  </div>
                </Panel>
                <MiniMap className='bg-card!' pannable zoomable />
              </Canvas>
            </CanvasDropZone>
            <CanvasNodeSearch
              nodes={editor.nodes}
              onOpenChange={handleNodeSearchOpenChange}
              onSelectNode={editor.selectNode}
              open={nodeSearchOpen}
            />
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
        models={imageToolModels}
        onBackgroundRemoval={imageTools.backgroundRemoval}
        onClose={imageTools.close}
        onCrop={imageTools.crop}
        onOutpaint={imageTools.outpaint}
        onRedraw={imageTools.redraw}
        onStyleReference={imageTools.styleReference}
        onUpscale={imageTools.upscale}
        source={imageTools.source}
        sourceSize={imageTools.sourceSize}
        tool={imageTools.tool}
      />

      <CanvasPngExportDialog
        onDownload={handleDownloadPng}
        onOpenChange={(open) => {
          if (!open) {
            setPngExport(null)
            setPngSaved(false)
          }
        }}
        onSave={() => void handleSavePng()}
        open={pngExport !== null}
        result={pngExport}
        saved={pngSaved}
        saving={pngSaving}
      />

      <CanvasTemplateLibraryDialog
        canvasId={props.project.id}
        canvasTitle={props.project.title}
        disabled={props.disabled}
        onApplyToCurrent={templateActions.applyToCurrent}
        onCreateFromTemplate={templateActions.createFromTemplate}
        onFlush={props.onBeforeExportArchive ?? (async () => undefined)}
        onOpenChange={setTemplatesOpen}
        open={templatesOpen}
      />

      <CanvasRunBudgetDialog
        group={workflowOptions.group}
        onOpenChange={(open) => {
          if (!open) setRunPlan(null)
        }}
        onRun={(budget?: CanvasWorkflowRunBudgetRef) => {
          const scope = runPlan?.scope
          setRunPlan(null)
          if (!scope) return
          if (scope === 'selection') {
            workflow.runSelection(budget)
            return
          }
          workflow.run(undefined, budget)
        }}
        open={runPlan !== null}
        steps={runPlan?.steps ?? []}
      />
    </div>
  )
}
