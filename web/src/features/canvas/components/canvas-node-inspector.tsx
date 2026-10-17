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
import { FileText, MessageSquare, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { GroupOption, ModelOption } from '@/features/playground/types'

import { CANVAS_NODE_KIND_LABELS } from '../constants'
import type {
  CanvasNodeDataUpdate,
  CanvasNodeDataUpdateOptions,
} from '../hooks/use-canvas-editor'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import {
  canvasNodeSourceTarget,
  type CanvasSourceTarget,
} from '../lib/canvas-navigation'
import {
  isCanvasWorkflowResult,
  isCanvasWorkflowStep,
  type CanvasWorkflowMention,
} from '../lib/canvas-workflow'
import type { CanvasFlowNode } from '../types'
import { CanvasNodeResultFields } from './canvas-node-result-fields'
import { CanvasNodeWorkflowFields } from './canvas-node-workflow-fields'

interface CanvasNodeInspectorProps {
  node: CanvasFlowNode | null
  disabled?: boolean
  models?: ModelOption[]
  groups?: GroupOption[]
  /** Directly connected upstream nodes the instruction can reference. */
  mentions?: CanvasWorkflowMention[]
  /** Transient run previews of the selected node; never persisted. */
  previews?: string[]
  runPhase?: CanvasWorkflowRunPhase
  onUpdateData: (
    id: string,
    update: CanvasNodeDataUpdate,
    options?: CanvasNodeDataUpdateOptions
  ) => void
  onDelete: (id: string) => void
  onRetry?: (nodeId: string) => void
  onOpenSource?: (target: CanvasSourceTarget) => void
}

export function CanvasNodeInspector(props: CanvasNodeInspectorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(props.node?.data.text ?? '')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const nodeId = props.node?.id ?? null

  useEffect(() => {
    setDraft(props.node?.data.text ?? '')
  }, [nodeId, props.node?.data.text])

  if (!props.node) {
    return (
      <p className='text-muted-foreground p-3 text-sm'>
        {t('Select a node to see its details.')}
      </p>
    )
  }

  const node = props.node
  const kindLabel = t(CANVAS_NODE_KIND_LABELS[node.data.kind])
  const snapshot = node.data.snapshot
  const reference = node.data.ref
  const sourceTarget = canvasNodeSourceTarget(reference)
  const editable =
    node.data.kind === 'text' ||
    node.data.kind === 'prompt' ||
    node.data.kind === 'note'

  const commitDraft = () => {
    const text = draft.trim()
    if (text === (node.data.text ?? '').trim()) return
    props.onUpdateData(node.id, { text: draft })
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3 p-3'>
      <div className='space-y-1'>
        <h3 className='text-sm font-medium'>{kindLabel}</h3>
        <p className='text-muted-foreground font-mono text-xs break-all'>
          {node.id}
        </p>
      </div>

      {node.data.sourceDeleted ? (
        <p className='border-warning/40 bg-warning/10 text-warning rounded-md border p-2 text-xs'>
          {t('The original was deleted. A saved snapshot is shown instead.')}
        </p>
      ) : null}

      {isCanvasWorkflowStep(node.data.kind) && props.onRetry ? (
        <CanvasNodeWorkflowFields
          disabled={props.disabled}
          groups={props.groups ?? []}
          mentions={props.mentions ?? []}
          models={props.models ?? []}
          node={node}
          onRetry={props.onRetry}
          onUpdateData={props.onUpdateData}
          previews={props.previews ?? []}
          runPhase={props.runPhase ?? 'idle'}
        />
      ) : null}

      {isCanvasWorkflowResult(node.data.kind) && props.onRetry ? (
        <CanvasNodeResultFields
          disabled={props.disabled}
          node={node}
          onRetry={props.onRetry}
          runPhase={props.runPhase ?? 'idle'}
        />
      ) : null}

      {editable ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Node content')}
          </span>
          <Textarea
            aria-label={t('Node content')}
            className='min-h-24'
            disabled={props.disabled}
            onBlur={commitDraft}
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
        </label>
      ) : null}

      {snapshot ? (
        <div className='grid gap-1'>
          <span className='text-muted-foreground text-xs'>
            {t('Message snapshot')}
          </span>
          <p className='text-muted-foreground rounded-md border p-2 text-xs break-words whitespace-pre-wrap'>
            {snapshot.text || t('Empty node')}
          </p>
          <p className='text-muted-foreground font-mono text-xs break-all'>
            {snapshot.role} · {snapshot.sessionId}
          </p>
        </div>
      ) : null}

      {reference ? (
        <dl className='grid gap-1 text-xs'>
          {reference.sessionId ? (
            <div className='flex justify-between gap-2'>
              <dt className='text-muted-foreground'>{t('Session')}</dt>
              <dd className='font-mono break-all'>{reference.sessionId}</dd>
            </div>
          ) : null}
          {reference.messageKey ? (
            <div className='flex justify-between gap-2'>
              <dt className='text-muted-foreground'>{t('Message')}</dt>
              <dd className='font-mono break-all'>{reference.messageKey}</dd>
            </div>
          ) : null}
          {reference.attachmentId ? (
            <div className='flex justify-between gap-2'>
              <dt className='text-muted-foreground'>{t('Attachment')}</dt>
              <dd className='font-mono break-all'>{reference.attachmentId}</dd>
            </div>
          ) : null}
          {reference.artifactId ? (
            <div className='flex justify-between gap-2'>
              <dt className='text-muted-foreground'>{t('Artifact')}</dt>
              <dd className='font-mono break-all'>{reference.artifactId}</dd>
            </div>
          ) : null}
          {reference.taskId ? (
            <div className='flex justify-between gap-2'>
              <dt className='text-muted-foreground'>{t('Task ID')}</dt>
              <dd className='font-mono break-all'>{reference.taskId}</dd>
            </div>
          ) : null}
          {reference.taskArtifactKey ? (
            <div className='flex justify-between gap-2'>
              <dt className='text-muted-foreground'>{t('Artifact')}</dt>
              <dd className='font-mono break-all'>
                {reference.taskArtifactKey}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {sourceTarget && props.onOpenSource ? (
        <div className='grid gap-2'>
          <span className='text-muted-foreground text-xs'>{t('Source')}</span>
          <div className='flex flex-wrap gap-2'>
            <Button
              disabled={props.disabled}
              onClick={() => props.onOpenSource?.(sourceTarget)}
              size='sm'
              type='button'
              variant='outline'
            >
              <MessageSquare aria-hidden='true' />
              {t('Open conversation')}
            </Button>
            {sourceTarget.artifactId ? (
              <Button
                disabled={props.disabled}
                onClick={() => props.onOpenSource?.(sourceTarget)}
                size='sm'
                type='button'
                variant='outline'
              >
                <FileText aria-hidden='true' />
                {t('Open artifact')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className='mt-auto flex justify-end'>
        <Button
          disabled={props.disabled}
          onClick={() => setConfirmOpen(true)}
          size='sm'
          type='button'
          variant='outline'
        >
          <Trash2 aria-hidden='true' />
          {t('Delete node')}
        </Button>
      </div>

      <ConfirmDialog
        confirmText={t('Delete')}
        desc={t('This node will be removed from the canvas.')}
        destructive
        handleConfirm={() => {
          props.onDelete(node.id)
          setConfirmOpen(false)
        }}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={t('Delete node?')}
      />
    </div>
  )
}
