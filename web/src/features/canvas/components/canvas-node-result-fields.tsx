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
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { translateServerText } from '@/lib/server-error-message'

import { CANVAS_WORKFLOW_GENERATION_LABELS } from '../constants'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import { canvasWorkflowRetrySource } from '../lib/canvas-workflow'
import type { CanvasFlowNode } from '../types'
import { CanvasWorkflowStatusBadge } from './canvas-workflow-status-badge'

interface CanvasNodeResultFieldsProps {
  node: CanvasFlowNode
  runPhase: CanvasWorkflowRunPhase
  disabled?: boolean
  onRetry: (nodeId: string) => void
}

/**
 * The generation record a result node keeps: the prompt, model and parameters
 * of the attempt that produced it plus the task reference. Retrying hands the
 * node back to the runner, which re-runs the step that produced the result
 * with exactly these parameters through the ordinary /pg routes.
 */
export function CanvasNodeResultFields(props: CanvasNodeResultFieldsProps) {
  const { t } = useTranslation()
  const node = props.node
  const workflow = node.data.workflow
  const reference = node.data.ref
  const sourceNodeId = canvasWorkflowRetrySource(node)
  const rows: { label: string; value: string | number }[] = []
  if (workflow?.model) rows.push({ label: t('Model'), value: workflow.model })
  if (workflow?.generation) {
    rows.push({
      label: t('Generation type'),
      value: t(CANVAS_WORKFLOW_GENERATION_LABELS[workflow.generation]),
    })
  }
  if (workflow?.size) rows.push({ label: t('Size'), value: workflow.size })
  if (workflow?.quality) {
    rows.push({ label: t('Quality'), value: workflow.quality })
  }
  if (workflow?.imageCount) {
    rows.push({ label: t('Count'), value: workflow.imageCount })
  }
  if (workflow?.duration) {
    rows.push({ label: t('Duration (seconds)'), value: workflow.duration })
  }
  if (workflow?.inputImageCount) {
    rows.push({
      label: t('Reference images'),
      value: workflow.inputImageCount,
    })
  }
  if (workflow?.group) rows.push({ label: t('Group'), value: workflow.group })
  if (reference?.taskId) {
    rows.push({ label: t('Task ID'), value: reference.taskId })
  }
  if (reference?.taskArtifactKey) {
    rows.push({ label: t('Artifact'), value: reference.taskArtifactKey })
  }

  return (
    <div className='grid gap-3 rounded-md border p-2'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground text-xs'>{t('Result')}</span>
        {workflow?.status ? (
          <CanvasWorkflowStatusBadge status={workflow.status} />
        ) : null}
      </div>

      {workflow?.inputText ? (
        <div className='grid gap-1'>
          <span className='text-muted-foreground text-xs'>{t('Prompt')}</span>
          <p className='text-muted-foreground rounded-md border p-2 text-xs break-words whitespace-pre-wrap'>
            {workflow.inputText}
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <dl className='grid gap-1 text-xs'>
          {rows.map((row) => (
            <div className='flex justify-between gap-2' key={row.label}>
              <dt className='text-muted-foreground'>{row.label}</dt>
              <dd className='truncate font-mono'>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {workflow?.error ? (
        <p className='text-destructive text-xs break-words whitespace-pre-wrap'>
          {translateServerText(t, workflow.error)}
        </p>
      ) : null}

      {sourceNodeId && props.runPhase === 'idle' ? (
        <Button
          disabled={props.disabled}
          onClick={() => props.onRetry(node.id)}
          size='sm'
          type='button'
          variant='outline'
        >
          <RotateCcw aria-hidden='true' />
          {t('Retry generation')}
        </Button>
      ) : null}
    </div>
  )
}
