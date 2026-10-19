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
import { Input } from '@/components/ui/input'
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
  CANVAS_WORKFLOW_CAPABILITY_MESSAGES,
  CANVAS_WORKFLOW_CUSTOM_SIZE,
  CANVAS_WORKFLOW_GENERATIONS,
  CANVAS_WORKFLOW_GENERATION_LABELS,
  CANVAS_WORKFLOW_IMAGE_COUNTS,
  CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT,
  CANVAS_WORKFLOW_IMAGE_QUALITIES,
  CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS,
  CANVAS_WORKFLOW_MESSAGES,
  CANVAS_WORKFLOW_SEED_MAX,
  CANVAS_WORKFLOW_SEED_MIN,
  CANVAS_WORKFLOW_VIDEO_SIZES,
  CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS,
} from '../constants'
import type {
  CanvasNodeDataUpdate,
  CanvasNodeDataUpdateOptions,
} from '../hooks/use-canvas-editor'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import {
  canvasWorkflowGenerationSupport,
  canvasWorkflowMentionMatches,
  canvasWorkflowMentionQuery,
  insertCanvasWorkflowMention,
  normalizeCanvasWorkflowSize,
  type CanvasWorkflowMention,
  type CanvasWorkflowModelCapability,
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
  /** Endpoint and task-usage metadata keyed by model name, when available. */
  modelCapabilities?: Record<string, CanvasWorkflowModelCapability>
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
  const currentSize = workflow?.size?.trim() ?? ''
  const presetSizes: readonly string[] =
    generation === 'video'
      ? CANVAS_WORKFLOW_VIDEO_SIZES
      : PLAYGROUND_IMAGE_SIZES
  const size =
    currentSize || (generation === 'image' ? PLAYGROUND_IMAGE_SIZES[0] : '')
  const duration = workflow?.duration ?? PLAYGROUND_VIDEO_DURATIONS[0]
  const canRetry =
    (status === 'failed' || status === 'canceled') && props.runPhase === 'idle'
  const capability = props.modelCapabilities?.[model.trim()]
  const generationSupport = canvasWorkflowGenerationSupport(capability)
  const generationSupported =
    generationSupport === null || generationSupport[generation]
  const bothGenerationsUnsupported =
    generationSupport !== null &&
    !generationSupport.image &&
    !generationSupport.video
  const capabilityReason =
    generationSupport === null
      ? null
      : bothGenerationsUnsupported
        ? CANVAS_WORKFLOW_CAPABILITY_MESSAGES.NO_MEDIA
        : generation === 'image' && !generationSupport.image
          ? CANVAS_WORKFLOW_CAPABILITY_MESSAGES.IMAGE_UNSUPPORTED
          : generation === 'video' && !generationSupport.video
            ? CANVAS_WORKFLOW_CAPABILITY_MESSAGES.VIDEO_UNSUPPORTED
            : null

  const [draft, setDraft] = useState(node.data.text ?? '')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [seedDraft, setSeedDraft] = useState(
    workflow?.seed === undefined ? '' : String(workflow.seed)
  )
  const [seedError, setSeedError] = useState<string | null>(null)
  const [customSizeOpen, setCustomSizeOpen] = useState(
    Boolean(currentSize && !presetSizes.includes(currentSize))
  )
  const [customSizeDraft, setCustomSizeDraft] = useState(currentSize)
  const [customSizeError, setCustomSizeError] = useState<string | null>(null)
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

  useEffect(() => {
    setSeedDraft(workflow?.seed === undefined ? '' : String(workflow.seed))
    setSeedError(null)
  }, [node.id, workflow?.seed])

  useEffect(() => {
    setCustomSizeOpen(
      Boolean(currentSize && !presetSizes.includes(currentSize))
    )
    setCustomSizeDraft(currentSize)
    setCustomSizeError(null)
  }, [node.id, generation, currentSize, presetSizes])

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

  const commitSeed = () => {
    const value = seedDraft.trim()
    if (!value) {
      setSeedError(null)
      if (workflow?.seed !== undefined) updateWorkflow({ seed: undefined })
      return
    }
    const seed = Number(value)
    if (
      !/^[0-9]+$/.test(value) ||
      !Number.isSafeInteger(seed) ||
      seed < CANVAS_WORKFLOW_SEED_MIN ||
      seed > CANVAS_WORKFLOW_SEED_MAX
    ) {
      setSeedError(CANVAS_WORKFLOW_MESSAGES.SEED_INVALID)
      return
    }
    setSeedError(null)
    setSeedDraft(String(seed))
    if (workflow?.seed !== seed) updateWorkflow({ seed })
  }

  const useLastSeed = () => {
    const lastSeed = workflow?.lastSeed
    if (!lastSeed) return
    setSeedDraft(String(lastSeed))
    setSeedError(null)
    updateWorkflow({ seed: lastSeed })
  }

  const applyCustomSize = () => {
    const normalized = normalizeCanvasWorkflowSize(customSizeDraft)
    if (!normalized) {
      setCustomSizeError(CANVAS_WORKFLOW_MESSAGES.SIZE_INVALID)
      return
    }
    setCustomSizeError(null)
    setCustomSizeDraft(normalized)
    setCustomSizeOpen(true)
    if (workflow?.size !== normalized) updateWorkflow({ size: normalized })
  }

  const durationOptions = withCurrentValue(
    PLAYGROUND_VIDEO_DURATIONS.map(String),
    String(duration)
  )
  const sizeSelectValue = customSizeOpen
    ? CANVAS_WORKFLOW_CUSTOM_SIZE
    : presetSizes.includes(currentSize)
      ? currentSize
      : size
  const sizeRatios =
    generation === 'video'
      ? CANVAS_WORKFLOW_VIDEO_SIZE_RATIOS
      : CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS

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
            disabled={props.disabled || bothGenerationsUnsupported}
            onChange={(event) =>
              updateWorkflow({
                generation: event.target.value as CanvasWorkflowGenerationKind,
              })
            }
            value={generation}
          >
            {CANVAS_WORKFLOW_GENERATIONS.map((option) => (
              <NativeSelectOption
                disabled={
                  generationSupport ? !generationSupport[option] : false
                }
                key={option}
                value={option}
              >
                {t(CANVAS_WORKFLOW_GENERATION_LABELS[option])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {capabilityReason ? (
            <p className='text-warning text-xs'>{t(capabilityReason)}</p>
          ) : null}
        </label>
      ) : null}

      {isTask ? (
        <div className='grid gap-1.5'>
          <label className='grid gap-1.5'>
            <span className='text-muted-foreground text-xs'>
              {generation === 'video' ? t('Video size') : t('Size')}
            </span>
            <NativeSelect
              disabled={props.disabled || !generationSupported}
              onChange={(event) => {
                const value = event.target.value
                if (value === CANVAS_WORKFLOW_CUSTOM_SIZE) {
                  setCustomSizeOpen(true)
                  setCustomSizeDraft(
                    currentSize && !presetSizes.includes(currentSize)
                      ? currentSize
                      : ''
                  )
                  setCustomSizeError(null)
                  return
                }
                setCustomSizeOpen(false)
                updateWorkflow({ size: value || undefined })
              }}
              value={sizeSelectValue}
            >
              {generation === 'video' ? (
                <NativeSelectOption value=''>
                  {t('Channel default')}
                </NativeSelectOption>
              ) : null}
              {presetSizes.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {sizeRatios[option]
                    ? `${option} · ${sizeRatios[option]}`
                    : option}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value={CANVAS_WORKFLOW_CUSTOM_SIZE}>
                {t('Custom size')}
              </NativeSelectOption>
            </NativeSelect>
          </label>
          {customSizeOpen ? (
            <div className='grid gap-1.5'>
              <div className='flex items-center gap-1.5'>
                <Input
                  aria-label={t('Size (WIDTHxHEIGHT)')}
                  disabled={props.disabled || !generationSupported}
                  inputMode='text'
                  onChange={(event) => setCustomSizeDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyCustomSize()
                  }}
                  placeholder='1024x1024'
                  value={customSizeDraft}
                />
                <Button
                  disabled={
                    props.disabled ||
                    !generationSupported ||
                    !customSizeDraft.trim()
                  }
                  onClick={applyCustomSize}
                  size='sm'
                  type='button'
                  variant='outline'
                >
                  {t('Apply')}
                </Button>
              </div>
              <p className='text-muted-foreground text-xs'>
                {t('WIDTHxHEIGHT, 64 to 8192 pixels per side.')}
              </p>
              {customSizeError ? (
                <p className='text-destructive text-xs'>
                  {translateServerText(t, customSizeError)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {isTask && generation === 'image' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>{t('Quality')}</span>
          <NativeSelect
            disabled={props.disabled || !generationSupported}
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
            disabled={props.disabled || !generationSupported}
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

      {isTask && generation === 'image' ? (
        <p className='text-muted-foreground text-xs'>
          {t('Each generated image gets its own result node.')}
        </p>
      ) : null}

      {isTask && generation === 'video' ? (
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Duration (seconds)')}
          </span>
          <NativeSelect
            disabled={props.disabled || !generationSupported}
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

      {isTask ? (
        <div className='grid gap-1.5'>
          <label className='grid gap-1.5'>
            <span className='text-muted-foreground text-xs'>{t('Seed')}</span>
            <Input
              aria-label={t('Seed')}
              disabled={props.disabled || !generationSupported}
              inputMode='numeric'
              onBlur={commitSeed}
              onChange={(event) => {
                setSeedDraft(event.target.value)
                setSeedError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitSeed()
              }}
              placeholder={t('Random')}
              value={seedDraft}
            />
          </label>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <p className='text-muted-foreground text-xs'>
              {workflow?.seed === undefined
                ? t('Leave empty for a random seed.')
                : t('The same seed will be reused on every run.')}
            </p>
            <Button
              disabled={
                props.disabled ||
                !generationSupported ||
                workflow?.lastSeed === undefined
              }
              onClick={useLastSeed}
              size='sm'
              type='button'
              variant='ghost'
            >
              {t('Use last result')}
            </Button>
          </div>
          {workflow?.lastSeed !== undefined ? (
            <p className='text-muted-foreground text-xs'>
              {t('Last seed: {{seed}}', { seed: workflow.lastSeed })}
            </p>
          ) : null}
          {seedError ? (
            <p className='text-destructive text-xs'>
              {translateServerText(t, seedError)}
            </p>
          ) : null}
        </div>
      ) : null}

      {workflow?.inputImageCount ? (
        <p className='text-muted-foreground text-xs'>
          {t('Reference images')}: {workflow.inputImageCount}
        </p>
      ) : null}

      {props.mentions.some((mention) => mention.hasImage) ? (
        <p className='text-muted-foreground text-xs'>
          {t('Connect at most {{count}} reference images to one step.', {
            count: CANVAS_WORKFLOW_IMAGE_INPUT_MAX_COUNT,
          })}
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
