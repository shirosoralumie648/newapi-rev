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
import { AtSign, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import {
  PLAYGROUND_IMAGE_SIZES,
  PLAYGROUND_VIDEO_DURATIONS,
} from '@/features/playground/constants'
import type { GroupOption, ModelOption } from '@/features/playground/types'
import { translateServerText } from '@/lib/server-error-message'

import {
  CANVAS_NODE_KIND_LABELS,
  CANVAS_WORKFLOW_GENERATIONS,
  CANVAS_WORKFLOW_GENERATION_LABELS,
  CANVAS_WORKFLOW_IMAGE_COUNTS,
  CANVAS_WORKFLOW_IMAGE_QUALITIES,
  CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS,
  CANVAS_WORKFLOW_VIDEO_SIZES,
  CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS,
} from '../constants'
import type {
  CanvasNodeDataUpdate,
  CanvasNodeDataUpdateOptions,
} from '../hooks/use-canvas-editor'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import {
  canvasWorkflowMentionMatches,
  canvasWorkflowMentionQuery,
  insertCanvasWorkflowMention,
  type CanvasWorkflowMention,
} from '../lib/canvas-workflow'
import type {
  CanvasFlowNode,
  CanvasNodeWorkflowState,
  CanvasWorkflowGenerationKind,
} from '../types'
import { CanvasWorkflowStatusBadge } from './canvas-workflow-status-badge'

interface CanvasNodeWorkflowFieldsProps {
  node: CanvasFlowNode
  models: ModelOption[]
  groups: GroupOption[]
  /** Directly connected upstream nodes the instruction can reference. */
  mentions: CanvasWorkflowMention[]
  /** Transient image previews of the current run for this node. */
  previews: string[]
  runPhase: CanvasWorkflowRunPhase
  disabled?: boolean
  onUpdateData: (
    id: string,
    update: CanvasNodeDataUpdate,
    options?: CanvasNodeDataUpdateOptions
  ) => void
  onRetry: (nodeId: string) => void
}

/** Adds the current value to a preset list so an imported board still shows it. */
function withCurrentValue(options: readonly string[], value: string): string[] {
  return options.includes(value) ? [...options] : [...options, value]
}

/**
 * Configuration and last-run detail of one `model`/`task` step: the model it
 * calls through the Playground relay, the generation parameters of a `task`
 * step, its instruction (with `@` references to connected nodes) and the
 * bounded output or failure of its last attempt. Nothing here holds a provider
 * URL or an API key; every field describes a request the server re-validates.
 */
export function CanvasNodeWorkflowFields(props: CanvasNodeWorkflowFieldsProps) {
  const { t } = useTranslation()
  const node = props.node
  const workflow = node.data.workflow
  const status = workflow?.status
  const model = workflow?.model ?? ''
  const isTask = node.data.kind === 'task'
  const generation: CanvasWorkflowGenerationKind =
    workflow?.generation === 'video' ? 'video' : 'image'
  const size = workflow?.size ?? PLAYGROUND_IMAGE_SIZES[0]
  const duration = workflow?.duration ?? PLAYGROUND_VIDEO_DURATIONS[0]
  const canRetry =
    (status === 'failed' || status === 'canceled') && props.runPhase === 'idle'

  const [draft, setDraft] = useState(node.data.text ?? '')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const caretRef = useRef(0)
  const mentionMatches =
    mentionQuery === null
      ? []
      : canvasWorkflowMentionMatches(props.mentions, mentionQuery)

  // A committed instruction or an undo of one replaces the draft; a run-state
  // update of the same node leaves the identical text alone while typing.
  useEffect(() => {
    setDraft(node.data.text ?? '')
    setMentionQuery(null)
  }, [node.id, node.data.text])

  const updateWorkflow = (patch: Partial<CanvasNodeWorkflowState>) => {
    props.onUpdateData(
      node.id,
      (data) => ({
        workflow: { ...data.workflow, ...patch },
      }),
      { mergeKey: `workflow:${node.id}` }
    )
  }

  const commitInstruction = () => {
    if (draft === (node.data.text ?? '')) return
    props.onUpdateData(
      node.id,
      { text: draft },
      { mergeKey: `text:${node.id}` }
    )
  }

  const insertMention = (mention: CanvasWorkflowMention) => {
    const next = insertCanvasWorkflowMention(
      draft,
      caretRef.current,
      mentionQuery ?? '',
      mention.label
    )
    caretRef.current = next.caret
    setDraft(next.value)
    setMentionQuery(null)
    props.onUpdateData(
      node.id,
      { text: next.value },
      { mergeKey: `text:${node.id}` }
    )
  }

  const imageSizeOptions = withCurrentValue(PLAYGROUND_IMAGE_SIZES, size)
  const durationOptions = withCurrentValue(
    PLAYGROUND_VIDEO_DURATIONS.map(String),
    String(duration)
  )

  return (
    <div className='grid gap-3 rounded-md border p-2'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground text-xs'>{t('Workflow')}</span>
        {status ? <CanvasWorkflowStatusBadge status={status} /> : null}
      </div>

      <div className='grid gap-1.5'>
        <div className='flex items-center justify-between gap-2'>
          <span className='text-muted-foreground text-xs'>
            {t('Instruction')}
          </span>
          {props.mentions.length > 0 ? (
            <Button
              disabled={props.disabled || props.runPhase === 'running'}
              onClick={() => {
                caretRef.current = draft.length
                setMentionQuery('')
              }}
              size='sm'
              type='button'
              variant='ghost'
            >
              <AtSign aria-hidden='true' />
              {t('Insert reference')}
            </Button>
          ) : null}
        </div>
        <Textarea
          aria-label={t('Instruction')}
          disabled={props.disabled}
          onBlur={commitInstruction}
          onChange={(event) => {
            const value = event.target.value
            caretRef.current = event.target.selectionStart ?? value.length
            setDraft(value)
            setMentionQuery(canvasWorkflowMentionQuery(value, caretRef.current))
          }}
          placeholder={t('Describe what you want to generate')}
          rows={3}
          value={draft}
        />
        {props.mentions.length > 0 ? (
          <p className='text-muted-foreground text-xs'>
            {t('Type @ to reference a connected resource.')}
          </p>
        ) : null}
        {mentionMatches.length > 0 ? (
          <div
            aria-label={t('Connected resources')}
            className='grid gap-1 rounded-md border p-1'
            role='group'
          >
            {mentionMatches.map((mention) => (
              <button
                className='hover:bg-muted/60 flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs'
                key={mention.nodeId}
                onClick={() => insertMention(mention)}
                type='button'
              >
                <span className='truncate'>{mention.label}</span>
                <span className='text-muted-foreground'>
                  {t(CANVAS_NODE_KIND_LABELS[mention.kind])}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <label className='grid gap-1.5'>
        <span className='text-muted-foreground text-xs'>{t('Model')}</span>
        <NativeSelect
          disabled={props.disabled || props.models.length === 0}
          onChange={(event) => updateWorkflow({ model: event.target.value })}
          value={model}
        >
          {props.models.length === 0 ? (
            <NativeSelectOption value=''>
              {t('No models available')}
            </NativeSelectOption>
          ) : null}
          {props.models.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>

      {props.groups.length > 0 ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>{t('Group')}</span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) => updateWorkflow({ group: event.target.value })}
            value={workflow?.group ?? ''}
          >
            <NativeSelectOption value=''>
              {t('Canvas group')}
            </NativeSelectOption>
            {props.groups.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {isTask ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Generation type')}
          </span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) =>
              updateWorkflow({
                generation: event.target.value as CanvasWorkflowGenerationKind,
              })
            }
            value={generation}
          >
            {CANVAS_WORKFLOW_GENERATIONS.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {t(CANVAS_WORKFLOW_GENERATION_LABELS[option])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {isTask && generation === 'image' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>{t('Size')}</span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) => updateWorkflow({ size: event.target.value })}
            value={size}
          >
            {imageSizeOptions.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS[option]
                  ? `${option} · ${CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS[option]}`
                  : option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {isTask && generation === 'image' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>{t('Quality')}</span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) =>
              updateWorkflow({ quality: event.target.value })
            }
            value={workflow?.quality ?? ''}
          >
            <NativeSelectOption value=''>
              {t('Channel default')}
            </NativeSelectOption>
            {CANVAS_WORKFLOW_IMAGE_QUALITIES.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {isTask && generation === 'image' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>{t('Count')}</span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) =>
              updateWorkflow({
                imageCount:
                  event.target.value === ''
                    ? undefined
                    : Number(event.target.value),
              })
            }
            value={workflow?.imageCount ? String(workflow.imageCount) : ''}
          >
            <NativeSelectOption value=''>
              {t('Channel default')}
            </NativeSelectOption>
            {CANVAS_WORKFLOW_IMAGE_COUNTS.map((option) => (
              <NativeSelectOption key={option} value={String(option)}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {isTask && generation === 'video' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Video size')}
          </span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) => updateWorkflow({ size: event.target.value })}
            value={workflow?.size ?? ''}
          >
            <NativeSelectOption value=''>
              {t('Channel default')}
            </NativeSelectOption>
            {CANVAS_WORKFLOW_VIDEO_SIZES.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {`${option} · ${CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS[option]}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {isTask && generation === 'video' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Duration (seconds)')}
          </span>
          <NativeSelect
            disabled={props.disabled}
            onChange={(event) =>
              updateWorkflow({ duration: Number(event.target.value) })
            }
            value={String(duration)}
          >
            {durationOptions.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      {workflow?.inputImageCount ? (
        <p className='text-muted-foreground text-xs'>
          {t('Reference images')}: {workflow.inputImageCount}
        </p>
      ) : null}

      {workflow?.attempts ? (
        <p className='text-muted-foreground text-xs'>
          {t('Attempts: {{count}}', { count: workflow.attempts })}
        </p>
      ) : null}

      {workflow?.error ? (
        <p className='text-destructive text-xs break-words whitespace-pre-wrap'>
          {translateServerText(t, workflow.error)}
        </p>
      ) : null}

      {workflow?.output ? (
        <div className='grid gap-1'>
          <span className='text-muted-foreground text-xs'>
            {t('Workflow output')}
          </span>
          <p className='text-muted-foreground rounded-md border p-2 text-xs break-words whitespace-pre-wrap'>
            {workflow.output}
          </p>
        </div>
      ) : null}

      {props.previews.length > 0 ? (
        <div className='grid gap-1'>
          <span className='text-muted-foreground text-xs'>
            {t('Generated image')}
          </span>
          <div className='grid gap-2'>
            {props.previews.map((source, index) => (
              <a
                href={source}
                key={source}
                rel='noopener noreferrer'
                target='_blank'
              >
                <img
                  alt={`${t('Generated image')} ${index + 1}`}
                  className='border-border/70 max-h-60 w-full rounded-md border object-contain'
                  src={source}
                />
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {canRetry ? (
        <Button
          disabled={props.disabled}
          onClick={() => props.onRetry(node.id)}
          size='sm'
          type='button'
          variant='outline'
        >
          <RotateCcw aria-hidden='true' />
          {t('Retry step')}
        </Button>
      ) : null}
    </div>
  )
}
