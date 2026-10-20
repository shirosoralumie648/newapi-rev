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
  Camera,
  Clapperboard,
  Image as ImageIcon,
  ListOrdered,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Square,
} from 'lucide-react'
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { WorkspaceInspector } from '@/components/workspace-inspector'
import { useIsMobile } from '@/hooks/use-mobile'
import { formatUseTime } from '@/lib/format'
import {
  getServerMessage,
  translateServerText,
} from '@/lib/server-error-message'

import {
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT,
  CANVAS_WORKFLOW_MESSAGES,
} from '../../constants'
import { useCanvasEditor } from '../../hooks/use-canvas-editor'
import { useCanvasNodeArtifact } from '../../hooks/use-canvas-node-artifact'
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
  CANVAS_VIDEO_FRAME_MESSAGES,
  CanvasVideoFrameError,
  captureCanvasVideoFrame,
} from '../../lib/canvas-video-frame'
import {
  canvasVideoWorkbenchDefaultStep,
  canvasVideoWorkbenchSource,
  canvasVideoWorkbenchStep,
  canvasVideoWorkbenchVariants,
} from '../../lib/canvas-video-workbench'
import { canvasWorkflowMentions } from '../../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasServerDocument,
  CanvasServerProject,
} from '../../types'
import { CanvasNodeResultFields } from '../canvas-node-result-fields'
import { CanvasNodeWorkflowFields } from '../canvas-node-workflow-fields'
import { CanvasRunBudgetDialog } from '../canvas-run-budget-dialog'
import { CanvasWorkflowStatusBadge } from '../canvas-workflow-status-badge'
import { CanvasTaskList } from '../generation/canvas-task-list'
import { CanvasTaskQueue } from '../generation/canvas-task-queue'
import { CanvasVideoWorkbenchVariants } from './canvas-video-workbench-variants'

interface CanvasVideoWorkbenchProps {
  project: CanvasServerProject
  disabled?: boolean
  onChange: (document: CanvasServerDocument) => void
  /** Turns the captured frame into a new image workbench project. */
  onOpenImageWorkbench: (file: File) => Promise<void>
}

type CapturedFrame = {
  file: File
  /** Object URL of the preview only; it is never stored on the project. */
  url: string
  seconds: number
}

type FrameAction = 'canvas' | 'image'

/**
 * The single-video layout of a video project. The focused step's preferred
 * artifact plays through the owner-scoped task artifact endpoint, its versions
 * sit underneath, and the ordinary workflow fields keep the duration, size and
 * model in the inspector. Frame capture reuses the attachment upload chain, so
 * a frame becomes an ordinary image node or a new image workbench project
 * instead of a second media pipeline.
 */
export function CanvasVideoWorkbench(props: CanvasVideoWorkbenchProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const workflowOptions = useCanvasWorkflowOptions()
  const [paramsOpen, setParamsOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [runPlan, setRunPlan] = useState<CanvasWorkflowRunPlan | null>(null)
  const [captured, setCaptured] = useState<CapturedFrame | null>(null)
  const [frameAction, setFrameAction] = useState<FrameAction | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [failedMediaUrl, setFailedMediaUrl] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const capturedRef = useRef<CapturedFrame | null>(null)

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

  const step = useMemo(
    () => canvasVideoWorkbenchStep(editor.nodes),
    [editor.nodes]
  )
  const variants = useMemo(
    () =>
      step
        ? canvasVideoWorkbenchVariants(step.id, editor.nodes, editor.edges)
        : [],
    [editor.edges, editor.nodes, step]
  )
  const preferredVariant =
    variants.find((variant) => variant.preferred) ??
    variants[variants.length - 1] ??
    null
  const activeNodeId = preferredVariant?.node.id ?? step?.id ?? null
  const mentions = useMemo(
    () =>
      step ? canvasWorkflowMentions(step, editor.nodes, editor.edges) : [],
    [editor.edges, editor.nodes, step]
  )
  const source = useMemo(
    () => canvasVideoWorkbenchSource(step, variants),
    [step, variants]
  )
  const artifactState = useCanvasNodeArtifact(
    source?.taskId,
    source?.artifactKey,
    'video'
  )

  const mediaUrl = artifactState.artifact?.content_url ?? ''
  const playerUrl = mediaUrl && mediaUrl !== failedMediaUrl ? mediaUrl : ''

  useEffect(() => {
    setFailedMediaUrl(null)
  }, [mediaUrl])

  const closeFrame = useCallback(() => {
    if (capturedRef.current) {
      URL.revokeObjectURL(capturedRef.current.url)
      capturedRef.current = null
    }
    setCaptured(null)
  }, [])

  useEffect(() => {
    return () => {
      if (capturedRef.current) URL.revokeObjectURL(capturedRef.current.url)
    }
  }, [])

  const workflowMessage = workflow.message
  const clearWorkflowMessage = workflow.clearMessage
  const notifyWorkflow = useCallback(() => {
    if (!workflowMessage) return
    toast.error(translateServerText(t, workflowMessage))
    clearWorkflowMessage()
  }, [clearWorkflowMessage, t, workflowMessage])
  useEffect(notifyWorkflow, [notifyWorkflow])

  const handleAddStep = useCallback(() => {
    if (editor.addNodes([canvasVideoWorkbenchDefaultStep()]) === 0) {
      toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
    }
  }, [editor, t])

  const handleGenerate = useCallback(() => {
    if (!step) return
    setRunPlan(workflow.estimate(step.id))
  }, [step, workflow])

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

  const handleCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    setCapturing(true)
    try {
      const frame = await captureCanvasVideoFrame(video)
      if (capturedRef.current) URL.revokeObjectURL(capturedRef.current.url)
      const next: CapturedFrame = {
        file: frame.file,
        url: URL.createObjectURL(frame.blob),
        seconds: frame.seconds,
      }
      capturedRef.current = next
      setCaptured(next)
    } catch (error) {
      toast.error(
        t(
          error instanceof CanvasVideoFrameError
            ? error.messageKey
            : CANVAS_VIDEO_FRAME_MESSAGES.CAPTURE_FAILED
        )
      )
    } finally {
      setCapturing(false)
    }
  }, [t])

  const handleAddFrameToCanvas = useCallback(async () => {
    const frame = capturedRef.current
    if (!frame || !step) return
    // A video step consumes at most four reference images. Refuse the frame
    // before uploading any bytes instead of mounting input the run would reject.
    if (
      mentions.filter((mention) => mention.hasImage).length >=
      CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT
    ) {
      toast.error(t(CANVAS_WORKFLOW_MESSAGES.IMAGE_INPUT_LIMIT))
      return
    }
    setFrameAction('canvas')
    try {
      const entries = await canvasDropEntries(props.project.id, step.position, [
        frame.file,
      ])
      const [entry] = entries
      if (!entry) {
        throw new CanvasDropError(CANVAS_VIDEO_FRAME_MESSAGES.ADD_FAILED)
      }
      // The upload chain returns an attachment node; a captured frame lands as
      // an image node left of the step and feeds the next i2v run through the
      // same edge a mounted reference image uses.
      const nodeId = nanoid()
      const accepted = editor.addNodes([
        {
          ...entry,
          id: nodeId,
          kind: 'image',
          position: {
            x: step.position.x - CANVAS_LINKED_NODE_OFFSET_X,
            y: step.position.y,
          },
        },
      ])
      if (accepted === 0) {
        toast.error(t(CANVAS_ERRORS.TOO_MANY_NODES))
        return
      }
      editor.handleConnect({
        source: nodeId,
        target: step.id,
        sourceHandle: null,
        targetHandle: null,
      })
      toast.success(t('Frame added to the canvas.'))
      closeFrame()
    } catch (error) {
      const message =
        error instanceof CanvasDropError
          ? error.messageKey
          : (getServerMessage(error) ?? CANVAS_VIDEO_FRAME_MESSAGES.ADD_FAILED)
      toast.error(translateServerText(t, message))
    } finally {
      setFrameAction(null)
    }
  }, [closeFrame, editor, mentions, props.project.id, step, t])

  const handleSendFrameToImageWorkbench = useCallback(async () => {
    const frame = capturedRef.current
    if (!frame) return
    setFrameAction('image')
    try {
      await props.onOpenImageWorkbench(frame.file)
      toast.success(t('Sent to the image workbench.'))
      closeFrame()
    } catch (error) {
      toast.error(
        translateServerText(
          t,
          getServerMessage(error) ??
            'The image workbench project could not be created.'
        )
      )
    } finally {
      setFrameAction(null)
    }
  }, [closeFrame, props.onOpenImageWorkbench, t])

  const header = (
    <div className='flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2'>
      <Badge variant='secondary'>{t('Video workbench')}</Badge>
      {step?.data.workflow?.status ? (
        <CanvasWorkflowStatusBadge status={step.data.workflow.status} />
      ) : null}
      <div className='ms-auto flex items-center gap-1'>
        <Button
          aria-label={t('Generation queue')}
          onClick={() => setQueueOpen(true)}
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <ListOrdered aria-hidden='true' />
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
            {t('Generate video')}
          </Button>
        )}
      </div>
    </div>
  )

  const previewFailed = artifactState.isError || Boolean(failedMediaUrl)
  let emptyTitle = t('No video generated yet.')
  let emptyDescription: string | undefined = t(
    'Run this step to generate the first video.'
  )
  if (!step) {
    emptyTitle = t('This project has no video step.')
    emptyDescription = t('Add a video step to start generating.')
  } else if (previewFailed) {
    emptyTitle = t('Preview unavailable')
    emptyDescription = undefined
  }

  const preview = (
    <div className='bg-muted/10 relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4'>
      {playerUrl ? (
        <video
          aria-label={t('Video player')}
          className='max-h-full max-w-full rounded-lg bg-black'
          controls
          key={playerUrl}
          onError={() => setFailedMediaUrl(playerUrl)}
          playsInline
          ref={videoRef}
          src={playerUrl}
        />
      ) : artifactState.isPending ? (
        <p
          className='text-muted-foreground flex items-center gap-2 text-sm'
          role='status'
        >
          <Spinner />
          {t('Loading video...')}
        </p>
      ) : (
        <EmptyState
          action={
            !step ? (
              <Button onClick={handleAddStep} type='button'>
                <Plus aria-hidden='true' />
                {t('Add video step')}
              </Button>
            ) : undefined
          }
          className='min-h-0 border-0'
          description={emptyDescription}
          icon={Clapperboard}
          title={emptyTitle}
        />
      )}
    </div>
  )

  const toolbar = (
    <div className='flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2'>
      <Button
        disabled={
          !playerUrl ||
          props.disabled ||
          capturing ||
          workflow.phase === 'running'
        }
        onClick={() => void handleCapture()}
        size='sm'
        type='button'
        variant='outline'
      >
        {capturing ? <Spinner /> : <Camera aria-hidden='true' />}
        {t('Capture frame')}
      </Button>
      <span className='text-muted-foreground text-xs'>
        {t('Seek the player, then capture the current frame.')}
      </span>
    </div>
  )

  const main = (
    <div className='flex h-full min-h-0 flex-col overflow-hidden'>
      {header}
      {preview}
      <CanvasVideoWorkbenchVariants
        activeNodeId={activeNodeId}
        disabled={props.disabled || workflow.phase === 'running'}
        onPrefer={handlePrefer}
        variants={variants}
      />
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
              previews={[]}
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
            {t('This project has no video step.')}
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

      <Dialog
        description={
          captured
            ? t('Captured at {{time}}', {
                time: formatUseTime(captured.seconds),
              })
            : undefined
        }
        footer={
          <>
            <Button
              disabled={!step || frameAction !== null}
              onClick={() => void handleAddFrameToCanvas()}
              type='button'
              variant='outline'
            >
              {frameAction === 'canvas' ? (
                <Spinner />
              ) : (
                <Plus aria-hidden='true' />
              )}
              {t('Add to canvas')}
            </Button>
            <Button
              disabled={frameAction !== null}
              onClick={() => void handleSendFrameToImageWorkbench()}
              type='button'
            >
              {frameAction === 'image' ? (
                <Spinner />
              ) : (
                <ImageIcon aria-hidden='true' />
              )}
              {t('Open in image workbench')}
            </Button>
          </>
        }
        onOpenChange={(open) => {
          if (!open) closeFrame()
        }}
        open={captured !== null}
        title={t('Captured frame')}
      >
        {captured ? (
          <img
            alt={t('Captured frame')}
            className='mx-auto max-h-[60svh] rounded-md border object-contain'
            src={captured.url}
          />
        ) : null}
      </Dialog>

      <Sheet onOpenChange={setQueueOpen} open={queueOpen}>
        {queueOpen ? (
          <SheetContent className='w-full gap-0 p-0 sm:max-w-md' side='right'>
            <SheetHeader className='border-b pr-12'>
              <SheetTitle>{t('Generation queue')}</SheetTitle>
              <SheetDescription>
                {t(
                  'Track running generations and their progress, and cancel a task to refund its reserved quota.'
                )}
              </SheetDescription>
            </SheetHeader>
            <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4'>
              <CanvasTaskQueue />
              <CanvasTaskList active onlyActive />
            </div>
          </SheetContent>
        ) : null}
      </Sheet>

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
