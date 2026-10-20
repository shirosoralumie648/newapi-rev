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
  ImageIcon,
  Info,
  Pin,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceInspector } from '@/components/workspace-inspector'
import { PLAYGROUND_ATTACHMENT_ACCEPT } from '@/features/playground/constants'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  getServerMessage,
  translateServerText,
} from '@/lib/server-error-message'

import {
  CANVAS_DROP_MESSAGES,
  CANVAS_IMAGE_TOOL_TITLES,
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT,
  CANVAS_WORKFLOW_MESSAGES,
  CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
} from '../../constants'
import {
  useCanvasEditor,
  type CanvasAddedNode,
} from '../../hooks/use-canvas-editor'
import { useCanvasImageTools } from '../../hooks/use-canvas-image-tools'
import { useCanvasWorkflowOptions } from '../../hooks/use-canvas-workflow-options'
import {
  useCanvasWorkflowRunner,
  type CanvasWorkflowRunPlan,
} from '../../hooks/use-canvas-workflow-runner'
import {
  CANVAS_ERRORS,
  toServerDocument,
  validateCanvasDocument,
} from '../../lib/canvas-document'
import { CanvasDropError, canvasDropEntries } from '../../lib/canvas-drop'
import {
  canvasImageToolModels,
  canvasImageToolSource,
  canvasImageToolUnavailableKinds,
  canvasImageToolUnavailableReason,
  type CanvasImageToolKind,
} from '../../lib/canvas-image-tools'
import {
  canvasImageWorkbenchAffixPlacements,
  canvasImageWorkbenchDefaultStep,
  canvasImageWorkbenchStep,
  canvasImageWorkbenchVariants,
} from '../../lib/canvas-image-workbench'
import {
  canvasWorkflowMentions,
  canvasWorkflowNodeHasImage,
  canvasWorkflowPreferredSibling,
} from '../../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasServerDocument,
  CanvasServerProject,
} from '../../types'
import { CanvasImageToolsDialog } from '../canvas-image-tools-dialog'
import { CanvasNodeResultFields } from '../canvas-node-result-fields'
import { CanvasNodeWorkflowFields } from '../canvas-node-workflow-fields'
import { CanvasRunBudgetDialog } from '../canvas-run-budget-dialog'
import { CanvasWorkflowStatusBadge } from '../canvas-workflow-status-badge'
import { CANVAS_IMAGE_TOOL_ICONS } from './canvas-image-tool-icons'
import { CanvasImageWorkbenchPreview } from './canvas-image-workbench-preview'
import { CanvasImageWorkbenchVariants } from './canvas-image-workbench-variants'

interface CanvasImageWorkbenchProps {
  project: CanvasServerProject
  disabled?: boolean
  onChange: (document: CanvasServerDocument) => void
}

const CANVAS_IMAGE_WORKBENCH_ZOOM_MIN = 0.25
const CANVAS_IMAGE_WORKBENCH_ZOOM_MAX = 4
const CANVAS_IMAGE_WORKBENCH_ZOOM_STEP = 0.25

/**
 * The single-image layout of an image project: the focused generation step's
 * latest/preferred image fills the page, its versions sit underneath, and the
 * ordinary CV-07 parameter fields stay in the inspector. The same editor state
 * and workflow runner power it, so generating, retrying and pinning follow the
 * board's billing and history rules instead of a second pipeline.
 */
export function CanvasImageWorkbench(props: CanvasImageWorkbenchProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const workflowOptions = useCanvasWorkflowOptions()
  const [paramsOpen, setParamsOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [runPlan, setRunPlan] = useState<CanvasWorkflowRunPlan | null>(null)
  const [uploadingReference, setUploadingReference] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleChange = useCallback(
    (nodes: CanvasFlowNode[], edges: CanvasFlowEdge[]) => {
      const canvasDocument = toServerDocument(
        nodes,
        edges,
        props.project.document.viewport
      )
      const limitError = validateCanvasDocument(canvasDocument)
      if (limitError) {
        toast.error(t(limitError))
        return
      }
      props.onChange(canvasDocument)
    },
    [props.onChange, props.project.document.viewport, t]
  )

  const editor = useCanvasEditor(props.project.document, handleChange, {
    shortcutsEnabled: false,
  })

  const workflow = useCanvasWorkflowRunner({
    nodes: editor.nodes,
    edges: editor.edges,
    group: workflowOptions.group,
    updateNodeData: editor.updateNodeData,
    addLinkedNode: editor.addLinkedNode,
  })

  const imageTools = useCanvasImageTools({
    canvasId: props.project.id,
    group: workflowOptions.group,
    modelCapabilities: workflowOptions.modelCapabilities,
    addLinkedNode: editor.addLinkedNode,
  })

  const step = useMemo(
    () => canvasImageWorkbenchStep(editor.nodes),
    [editor.nodes]
  )
  const variants = useMemo(
    () =>
      step
        ? canvasImageWorkbenchVariants(step.id, editor.nodes, editor.edges)
        : [],
    [editor.edges, editor.nodes, step]
  )
  const preferredVariant =
    variants.find((variant) => variant.preferred) ??
    variants[variants.length - 1] ??
    null
  const activeNodeId = preferredVariant?.node.id ?? step?.id ?? null
  const previews = step ? (workflow.results[step.id] ?? []) : []
  const activeVariantIndex = preferredVariant
    ? variants.indexOf(preferredVariant)
    : -1
  const activePreview =
    activeVariantIndex >= 0 ? previews[activeVariantIndex] : previews[0]
  const previewNode = preferredVariant?.node ?? step
  const toolNode =
    preferredVariant &&
    canvasImageToolSource(preferredVariant.node.data) !== null
      ? preferredVariant.node
      : null

  const mentions = useMemo(
    () =>
      step ? canvasWorkflowMentions(step, editor.nodes, editor.edges) : [],
    [editor.edges, editor.nodes, step]
  )

  // The reference strip mirrors the images the step actually consumes: the
  // mounted attachment or the preferred sibling of a result chain, in edge
  // order. Removing one disconnects the edge and keeps the source node.
  const references = useMemo(() => {
    if (!step) return []
    return canvasWorkflowMentions(step, editor.nodes, editor.edges).flatMap(
      (mention) => {
        if (!mention.hasImage) return []
        const upstream = editor.nodes.find((node) => node.id === mention.nodeId)
        if (!upstream) return []
        const preferred = canvasWorkflowPreferredSibling(upstream, editor.nodes)
        const node =
          preferred && canvasWorkflowNodeHasImage(preferred.data)
            ? preferred
            : upstream
        const edge = editor.edges.find(
          (item) => item.target === step.id && item.source === mention.nodeId
        )
        return edge ? [{ edgeId: edge.id, node, label: mention.label }] : []
      }
    )
  }, [editor.edges, editor.nodes, step])

  const unavailableImageTools = useMemo(
    () =>
      canvasImageToolUnavailableKinds(
        workflowOptions.models,
        workflowOptions.modelCapabilities
      ),
    [workflowOptions.modelCapabilities, workflowOptions.models]
  )
  const hiddenImageTools = new Set<CanvasImageToolKind>(unavailableImageTools)

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

  const workflowMessage = workflow.message
  const clearWorkflowMessage = workflow.clearMessage
  const notifyWorkflow = useCallback(() => {
    if (!workflowMessage) return
    toast.error(translateServerText(t, workflowMessage))
    clearWorkflowMessage()
  }, [clearWorkflowMessage, t, workflowMessage])
  useEffect(notifyWorkflow, [notifyWorkflow])

  const imageToolMessage = imageTools.message
  const clearImageToolMessage = imageTools.clearMessage
  const notifyImageTool = useCallback(() => {
    if (!imageToolMessage) return
    toast.error(translateServerText(t, imageToolMessage))
    clearImageToolMessage()
  }, [clearImageToolMessage, imageToolMessage, t])
  useEffect(notifyImageTool, [notifyImageTool])

  const handleAddStep = useCallback(() => {
    if (editor.addNodes([canvasImageWorkbenchDefaultStep()]) === 0) {
      toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
    }
  }, [editor, t])

  const handleGenerate = useCallback(() => {
    if (!step) return
    setRunPlan(workflow.estimate(step.id))
  }, [step, workflow])

  const handlePin = useCallback(() => {
    if (!step) return
    const placements = canvasImageWorkbenchAffixPlacements(
      step,
      variants,
      editor.nodes
    )
    if (editor.affixNodes(placements)) {
      toast.success(t('Pinned to the canvas board.'))
    }
  }, [editor, step, t, variants])

  const handlePrefer = useCallback(
    (nodeId: string) => {
      if (!step) return
      const result = editor.nodes.find((node) => node.id === nodeId)
      if (!result) return
      // An imported sibling may only keep the preferred flag. Record the source
      // first so the same choice also settles `preferredResultNodeId`.
      if (result.data.workflow?.sourceNodeId?.trim() !== step.id) {
        editor.updateNodeData(nodeId, (data) => ({
          workflow: { ...data.workflow, sourceNodeId: step.id },
        }))
      }
      editor.setWorkflowPreferredResult(nodeId)
    },
    [editor, step]
  )

  const handleRemoveReference = useCallback(
    (edgeId: string) => {
      editor.handleEdgesChange([{ type: 'remove', id: edgeId }])
    },
    [editor]
  )

  const handleReferenceFiles = useCallback(
    async (files: File[]) => {
      if (!step || props.disabled || files.length === 0) return
      // A step consumes at most four images. Refuse the whole selection before
      // uploading any bytes instead of mounting references the run would reject.
      const room = CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT - references.length
      if (files.length > Math.max(room, 0)) {
        toast.error(t(CANVAS_WORKFLOW_MESSAGES.IMAGE_INPUT_LIMIT))
        return
      }
      setUploadingReference(true)
      try {
        let entries: CanvasAddedNode[]
        try {
          entries = await canvasDropEntries(
            props.project.id,
            step.position,
            files
          )
        } catch (error) {
          const message =
            error instanceof CanvasDropError
              ? error.messageKey
              : (getServerMessage(error) ?? CANVAS_DROP_MESSAGES.UPLOAD_FAILED)
          toast.error(translateServerText(t, message))
          return
        }
        // Each reference lands left of the step in one column; ids are assigned
        // before the insert so the mount can link every new node to the step.
        const positioned = entries.map((entry, index) => ({
          ...entry,
          id: nanoid(),
          position: {
            x: step.position.x - CANVAS_LINKED_NODE_OFFSET_X,
            y: step.position.y + index * CANVAS_WORKFLOW_RESULT_NODE_OFFSET_Y,
          },
        }))
        const accepted = editor.addNodes(positioned)
        if (accepted < positioned.length) {
          toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
        }
        for (const entry of positioned.slice(0, accepted)) {
          editor.handleConnect({
            source: entry.id ?? '',
            target: step.id,
            sourceHandle: null,
            targetHandle: null,
          })
        }
        if (accepted === 1) {
          toast.success(t('Reference image added.'))
        } else if (accepted > 1) {
          toast.success(t('Reference images added.'))
        }
      } finally {
        setUploadingReference(false)
      }
    },
    [editor, props.disabled, props.project.id, references, step, t]
  )

  const header = (
    <div className='flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2'>
      <Badge variant='secondary'>{t('Image workbench')}</Badge>
      {step?.data.workflow?.status ? (
        <CanvasWorkflowStatusBadge status={step.data.workflow.status} />
      ) : null}
      <div className='ms-auto flex items-center gap-1'>
        <Button
          aria-label={t('Zoom out')}
          disabled={zoom <= CANVAS_IMAGE_WORKBENCH_ZOOM_MIN}
          onClick={() =>
            setZoom((value) =>
              Math.max(
                CANVAS_IMAGE_WORKBENCH_ZOOM_MIN,
                value - CANVAS_IMAGE_WORKBENCH_ZOOM_STEP
              )
            )
          }
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <ZoomOut aria-hidden='true' />
        </Button>
        <Button
          aria-label={t('Reset zoom')}
          className='w-12 font-mono text-xs'
          onClick={() => setZoom(1)}
          size='sm'
          type='button'
          variant='ghost'
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          aria-label={t('Zoom in')}
          disabled={zoom >= CANVAS_IMAGE_WORKBENCH_ZOOM_MAX}
          onClick={() =>
            setZoom((value) =>
              Math.min(
                CANVAS_IMAGE_WORKBENCH_ZOOM_MAX,
                value + CANVAS_IMAGE_WORKBENCH_ZOOM_STEP
              )
            )
          }
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <ZoomIn aria-hidden='true' />
        </Button>
        {isMobile ? (
          <Button
            aria-label={t('Parameters')}
            onClick={() => setParamsOpen(true)}
            size='icon-sm'
            type='button'
            variant='ghost'
          >
            <SlidersHorizontal aria-hidden='true' />
          </Button>
        ) : null}
        {workflow.phase === 'running' ? (
          <Button
            onClick={() => void workflow.cancel()}
            size='sm'
            type='button'
            variant='outline'
          >
            <Square aria-hidden='true' />
            {t('Cancel run')}
          </Button>
        ) : (
          <Button
            disabled={!step || props.disabled}
            onClick={handleGenerate}
            size='sm'
            type='button'
          >
            <Sparkles aria-hidden='true' />
            {t('Generate image')}
          </Button>
        )}
      </div>
    </div>
  )

  const preview = (
    <div className='bg-muted/10 relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4'>
      {activePreview ||
      (previewNode && canvasImageToolSource(previewNode.data) !== null) ? (
        <CanvasImageWorkbenchPreview
          alt={t('Generated image')}
          node={previewNode ?? null}
          preview={activePreview}
          zoom={zoom}
        />
      ) : (
        <EmptyState
          action={
            !step ? (
              <Button onClick={handleAddStep} type='button'>
                <Plus aria-hidden='true' />
                {t('Add image step')}
              </Button>
            ) : undefined
          }
          className='min-h-0 border-0'
          description={
            step
              ? t('Run this step to generate the first image.')
              : t('Add an image step to start generating.')
          }
          icon={ImageIcon}
          title={
            step
              ? t('No image generated yet.')
              : t('This project has no image step.')
          }
        />
      )}
    </div>
  )

  const referenceStrip =
    references.length > 0 ? (
      <div className='flex shrink-0 items-center gap-2 border-t px-3 py-2'>
        <span className='text-muted-foreground text-xs'>
          {t('Reference images')}
        </span>
        <div className='flex min-w-0 gap-2 overflow-x-auto'>
          {references.map((reference, index) => (
            <div
              className='bg-muted/20 relative size-14 shrink-0 overflow-hidden rounded-md border'
              key={reference.node.id}
            >
              <CanvasImageWorkbenchPreview
                alt={
                  reference.label ||
                  t('Reference image {{index}}', { index: index + 1 })
                }
                className='size-full'
                node={reference.node}
              />
              <Button
                aria-label={t('Remove reference image')}
                className='absolute top-0.5 right-0.5'
                onClick={() => handleRemoveReference(reference.edgeId)}
                size='icon-xs'
                type='button'
                variant='secondary'
              >
                <X aria-hidden='true' />
              </Button>
            </div>
          ))}
        </div>
      </div>
    ) : null

  const toolbar = (
    <div className='flex shrink-0 flex-wrap items-center gap-1 border-t px-3 py-2'>
      <TooltipProvider delay={0}>
        {(Object.keys(CANVAS_IMAGE_TOOL_TITLES) as CanvasImageToolKind[])
          .filter((tool) => !hiddenImageTools.has(tool))
          .map((tool) => {
            const Icon = CANVAS_IMAGE_TOOL_ICONS[tool]
            return (
              <Tooltip key={tool}>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t(CANVAS_IMAGE_TOOL_TITLES[tool])}
                      disabled={
                        props.disabled || imageTools.busy || toolNode === null
                      }
                      onClick={() => {
                        if (toolNode) imageTools.open(toolNode, tool)
                      }}
                      size='icon-sm'
                      type='button'
                      variant='outline'
                    />
                  }
                >
                  <Icon aria-hidden='true' />
                </TooltipTrigger>
                <TooltipContent>
                  {t(CANVAS_IMAGE_TOOL_TITLES[tool])}
                </TooltipContent>
              </Tooltip>
            )
          })}
        {unavailableImageTools.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t('Why some image tools are hidden')}
                  size='icon-sm'
                  type='button'
                  variant='ghost'
                />
              }
            >
              <Info aria-hidden='true' />
            </TooltipTrigger>
            <TooltipContent>
              <div className='grid gap-1'>
                {unavailableImageTools.map((tool) => (
                  <span key={tool}>
                    {t(canvasImageToolUnavailableReason(tool))}
                  </span>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </TooltipProvider>

      <div className='ms-auto flex flex-wrap items-center gap-2'>
        <input
          accept={PLAYGROUND_ATTACHMENT_ACCEPT}
          className='hidden'
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void handleReferenceFiles(files)
          }}
          ref={fileInputRef}
          type='file'
        />
        <Button
          disabled={!step || props.disabled || uploadingReference}
          onClick={() => fileInputRef.current?.click()}
          size='sm'
          type='button'
          variant='outline'
        >
          {uploadingReference ? <Spinner /> : <ImageIcon aria-hidden='true' />}
          {t('Add reference image')}
        </Button>
        <Button
          disabled={!step || props.disabled}
          onClick={handlePin}
          size='sm'
          type='button'
          variant='outline'
        >
          <Pin aria-hidden='true' />
          {t('Pin to canvas')}
        </Button>
      </div>
    </div>
  )

  const main = (
    <div className='flex h-full min-h-0 flex-col overflow-hidden'>
      {header}
      {preview}
      <CanvasImageWorkbenchVariants
        activeNodeId={activeNodeId}
        disabled={props.disabled || workflow.phase === 'running'}
        onPrefer={handlePrefer}
        previews={previews}
        variants={variants}
      />
      {referenceStrip}
      {toolbar}
    </div>
  )

  const inspector = (
    <div className='bg-muted/10 flex h-full min-h-0 w-full flex-col overflow-hidden border-l'>
      <div className='min-h-0 flex-1 overflow-y-auto p-3'>
        {step ? (
          <div className='grid gap-4'>
            <CanvasNodeWorkflowFields
              disabled={props.disabled}
              groups={workflowOptions.groups}
              mentions={mentions}
              modelCapabilities={workflowOptions.modelCapabilities}
              models={workflowOptions.models}
              node={step}
              onRetry={workflow.retry}
              onUpdateData={editor.updateNodeData}
              previews={previews}
              runPhase={workflow.phase}
            />
            {preferredVariant ? (
              <CanvasNodeResultFields
                canPrefer={variants.length > 1}
                disabled={props.disabled}
                node={preferredVariant.node}
                onPrefer={handlePrefer}
                onRetry={workflow.retry}
                preferred={preferredVariant.preferred}
                runPhase={workflow.phase}
              />
            ) : null}
          </div>
        ) : (
          <p className='text-muted-foreground text-sm'>
            {t('This project has no image step.')}
          </p>
        )}
      </div>
    </div>
  )

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden'>
      <WorkspaceInspector
        main={main}
        onClose={() => setParamsOpen(false)}
        open={isMobile ? paramsOpen : true}
        panelDefaultSize='30'
        panelMinSize='22'
        title={t('Parameters')}
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

      <CanvasRunBudgetDialog
        group={workflowOptions.group}
        onOpenChange={(open) => {
          if (!open) setRunPlan(null)
        }}
        onRun={(budget) => {
          const nodeId = step?.id
          setRunPlan(null)
          if (!nodeId) return
          workflow.run(nodeId, budget)
        }}
        open={runPlan !== null}
        steps={runPlan?.steps ?? []}
      />
    </div>
  )
}
