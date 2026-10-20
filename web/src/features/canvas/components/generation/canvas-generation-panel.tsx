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
import { Loader2, RotateCcw, Sparkles, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { CANVAS_WORKFLOW_CAPABILITY_MESSAGES } from '@/features/canvas/constants'
import type { CanvasSendSeed } from '@/features/canvas/lib/canvas-send'
import {
  canvasWorkflowGenerationSupport,
  type CanvasWorkflowModelCapability,
} from '@/features/canvas/lib/canvas-workflow'
import {
  PLAYGROUND_AUDIO_VOICES,
  PLAYGROUND_GENERATION_BATCH_CONCURRENCY,
  PLAYGROUND_GENERATION_BATCH_MESSAGES,
  PLAYGROUND_GENERATION_COMPARE_MAX,
  PLAYGROUND_GENERATION_ERRORS,
  PLAYGROUND_GENERATION_KINDS,
  PLAYGROUND_GENERATION_MODES,
  PLAYGROUND_GENERATION_MODE_LABELS,
  PLAYGROUND_GENERATION_SEED_MAX,
  PLAYGROUND_GENERATION_SEED_MIN,
  PLAYGROUND_GENERATION_SEED_MODES,
  PLAYGROUND_GENERATION_VARIATION_MAX,
  PLAYGROUND_IMAGE_QUALITIES,
  PLAYGROUND_IMAGE_SIZES,
  PLAYGROUND_VIDEO_DURATIONS,
  PLAYGROUND_VIDEO_SIZES,
} from '@/features/playground/constants'
import type { PlaygroundImageResult } from '@/features/playground/generation-api'
import {
  usePlaygroundGeneration,
  usePlaygroundTasks,
} from '@/features/playground/hooks'
import {
  buildGenerationBatchPlan,
  clampGenerationVariationCount,
  collectGenerationSchemaOptions,
  emptyGenerationSchemaOptions,
  generationLimits,
  generationOptionSets,
  mergeGenerationSchemaOptions,
  normalizeGenerationModels,
  type GenerationBatchBlockedModel,
  type GenerationBatchKind,
  type GenerationBatchPlan,
  type GenerationCapabilityLimits,
  type GenerationSchemaOptions,
  type GenerationSeedMode,
} from '@/features/playground/lib/generation/generation-batch'
import type {
  ModelOption,
  PlaygroundGenerationKind,
} from '@/features/playground/types'
import { handleServerError } from '@/lib/handle-server-error'

import type { CanvasWorkflowRunEstimate } from '../../api'
import { useCanvasGenerationBatch } from '../../hooks/use-canvas-generation-batch'
import type { CanvasWorkflowRunBudgetRef } from '../../hooks/use-canvas-workflow-runner'
import { generationPlanEstimateSteps } from '../../lib/canvas-generation-run'
import { CanvasRunBudgetDialog } from '../canvas-run-budget-dialog'
import { CanvasGenerationResults } from './canvas-generation-results'
import { CanvasTaskList } from './canvas-task-list'
import { CanvasTaskQueue } from './canvas-task-queue'

type GenerationMode = (typeof PLAYGROUND_GENERATION_MODES)[number]

const GENERATION_KIND_LABELS: Record<PlaygroundGenerationKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
}

const GENERATION_ERROR_KEYS: Record<PlaygroundGenerationKind, string> = {
  image: PLAYGROUND_GENERATION_ERRORS.IMAGE_FAILED,
  video: PLAYGROUND_GENERATION_ERRORS.VIDEO_FAILED,
  audio: PLAYGROUND_GENERATION_ERRORS.AUDIO_FAILED,
}

// Only image and video carry generation support in the model catalog; an audio
// model has no capability metadata to judge, so it is never gated.
const GENERATION_CAPABILITY_MESSAGES: Partial<
  Record<PlaygroundGenerationKind, string>
> = {
  image: CANVAS_WORKFLOW_CAPABILITY_MESSAGES.IMAGE_UNSUPPORTED,
  video: CANVAS_WORKFLOW_CAPABILITY_MESSAGES.VIDEO_UNSUPPORTED,
}

interface GenerationPlanNotice {
  messageKey: string
  values: Record<string, string>
}

/**
 * Flattens the parameter mappings of a plan into display notices. Variations
 * repeat the same mapping for every seed, so notices are de-duplicated per
 * model and value while the per-cell result keeps its own trace.
 */
function generationAdjustmentNotices(
  plan: GenerationBatchPlan
): GenerationPlanNotice[] {
  const seen = new Set<string>()
  const notices: GenerationPlanNotice[] = []
  for (const request of plan.requests) {
    for (const adjustment of request.adjustments) {
      const key = `${request.model}|${adjustment.field}|${adjustment.from}|${adjustment.to}`
      if (seen.has(key)) continue
      seen.add(key)
      notices.push({
        messageKey: adjustment.messageKey,
        values: {
          from: adjustment.from,
          to: adjustment.to,
          model: request.model,
        },
      })
    }
  }
  return notices
}

interface CanvasGenerationPanelProps {
  active: boolean
  disabled?: boolean
  group: string
  /** Endpoint, task-usage, size, quality and duration metadata per model. */
  modelCapabilities?: Record<string, CanvasWorkflowModelCapability>
  models: ModelOption[]
  /** Prompt a conversation message action handed to the canvas. */
  initialPrompt?: string
  initialKind?: PlaygroundGenerationKind
  onSendToCanvas: (seeds: CanvasSendSeed[]) => void
}

/**
 * The canvas generation entry. Image, video and audio requests are mapped to
 * the existing Relay routes through /pg, so channel selection, permissions and
 * billing are the ordinary pipeline; async results are then tracked through the
 * account's durable task rows. Generation lives on the canvas side of the
 * workspace: the conversation only bridges a message into a prefilled canvas.
 *
 * A seed grid and a cross-model comparison are bounded batches of the same
 * single request: they reuse the Relay pre-charge and BL-03 run estimate
 * instead of introducing a second generation or billing path.
 */
export function CanvasGenerationPanel(props: CanvasGenerationPanelProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<PlaygroundGenerationKind>(
    props.initialKind ?? 'image'
  )
  const [mode, setMode] = useState<GenerationMode>('single')
  const [model, setModel] = useState('')
  const [compareModels, setCompareModels] = useState<string[]>([])
  const [prompt, setPrompt] = useState(props.initialPrompt ?? '')
  const [imageSize, setImageSize] = useState<string>(PLAYGROUND_IMAGE_SIZES[0])
  const [videoSize, setVideoSize] = useState<string>(PLAYGROUND_VIDEO_SIZES[0])
  const [quality, setQuality] = useState('')
  const [duration, setDuration] = useState<number>(
    PLAYGROUND_VIDEO_DURATIONS[0]
  )
  const [voice, setVoice] = useState<string>(PLAYGROUND_AUDIO_VOICES[0])
  const [variationCount, setVariationCount] = useState(4)
  const [seedMode, setSeedMode] = useState<GenerationSeedMode>('increment')
  const [seed, setSeed] = useState('')
  const [images, setImages] = useState<PlaygroundImageResult[]>([])
  const [imageTaskSubmitted, setImageTaskSubmitted] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<GenerationBatchPlan | null>(
    null
  )
  const [planError, setPlanError] = useState<string | null>(null)
  const [planNotices, setPlanNotices] = useState<GenerationPlanNotice[]>([])
  const [blockedModels, setBlockedModels] = useState<
    GenerationBatchBlockedModel[]
  >([])
  const generation = usePlaygroundGeneration()
  const batch = useCanvasGenerationBatch()
  const tasksQuery = usePlaygroundTasks(props.active)

  useEffect(() => {
    const firstModel = props.models[0]?.value ?? ''
    if (!model && firstModel) setModel(firstModel)
  }, [model, props.models])

  useEffect(() => {
    if (props.initialKind) setKind(props.initialKind)
  }, [props.initialKind])

  useEffect(() => {
    if (props.initialPrompt !== undefined) setPrompt(props.initialPrompt)
  }, [props.initialPrompt])

  useEffect(() => {
    if (kind === 'audio') setMode('single')
  }, [kind])

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  const controlsDisabled = props.disabled || isSubmitting || batch.running
  // A catalog row that proves the selected model cannot serve the current kind
  // disables the send; unknown metadata keeps the panel usable, matching the
  // canvas node controls. In compare mode the batch plan validates every
  // selected model instead of the hidden single-model select.
  const generationSupport = canvasWorkflowGenerationSupport(
    props.modelCapabilities?.[model.trim()]
  )
  const generationUnsupported =
    mode !== 'compare' &&
    kind !== 'audio' &&
    generationSupport !== null &&
    !generationSupport[kind]
  const capabilityReason = generationUnsupported
    ? (GENERATION_CAPABILITY_MESSAGES[kind] ?? null)
    : null

  const trimmedPrompt = prompt.trim()
  const availableModelValues = props.models.map((option) => option.value)
  const selectedCompareModels = normalizeGenerationModels(compareModels).filter(
    (value) => availableModelValues.includes(value)
  )
  // A comparison always starts from two models, but the user may reduce it to
  // one while choosing a different pair; the plan then reports the 2–4 rule.
  const compareSelection =
    selectedCompareModels.length > 0
      ? selectedCompareModels
      : availableModelValues.slice(0, 2)
  const planModels =
    mode === 'compare' ? compareSelection : model.trim() ? [model.trim()] : []
  const batchKind: GenerationBatchKind | null = kind === 'audio' ? null : kind
  const selectedBatchModels = batchKind
    ? normalizeGenerationModels(planModels)
    : []
  const schemaByModel = useMemo(() => {
    const result: Record<string, GenerationSchemaOptions> = {}
    for (const name of selectedBatchModels) {
      const capability = props.modelCapabilities?.[name]
      const support = canvasWorkflowGenerationSupport(capability)
      result[name] = collectGenerationSchemaOptions(
        emptyGenerationSchemaOptions(),
        capability?.usageSchema,
        {
          image: support?.image ?? true,
          video: support?.video ?? true,
        }
      )
    }
    return result
  }, [props.modelCapabilities, selectedBatchModels])
  const mergedSchemaOptions = useMemo(
    () =>
      Object.values(schemaByModel).reduce(
        (merged, options) => mergeGenerationSchemaOptions(merged, options),
        emptyGenerationSchemaOptions()
      ),
    [schemaByModel]
  )
  const modelLimits = useMemo(() => {
    const limits: Record<string, GenerationCapabilityLimits> = {}
    for (const name of selectedBatchModels) {
      const capability = props.modelCapabilities?.[name]
      limits[name] = generationLimits(
        batchKind ?? 'image',
        schemaByModel[name],
        canvasWorkflowGenerationSupport(capability)
      )
    }
    return limits
  }, [batchKind, props.modelCapabilities, schemaByModel, selectedBatchModels])
  const optionSets = batchKind
    ? generationOptionSets(batchKind, mergedSchemaOptions)
    : null
  const selectedSize = kind === 'image' ? imageSize : videoSize
  const sizeOptions = [
    ...new Set([
      selectedSize,
      ...(optionSets?.sizes ??
        (kind === 'image'
          ? [...PLAYGROUND_IMAGE_SIZES]
          : [...PLAYGROUND_VIDEO_SIZES])),
    ]),
  ]
  const qualityOptions = [
    ...new Set([
      quality,
      ...(optionSets?.qualities ?? [...PLAYGROUND_IMAGE_QUALITIES]),
    ]),
  ].filter(Boolean)
  const durationOptions = [
    ...new Set([
      duration,
      ...(optionSets?.durations ?? [...PLAYGROUND_VIDEO_DURATIONS]),
    ]),
  ]
  const trimmedSeed = seed.trim()
  const seedNumber = trimmedSeed === '' ? undefined : Number(trimmedSeed)
  const seedInvalid =
    trimmedSeed !== '' &&
    (seedNumber === undefined ||
      !Number.isInteger(seedNumber) ||
      seedNumber < PLAYGROUND_GENERATION_SEED_MIN ||
      seedNumber > PLAYGROUND_GENERATION_SEED_MAX)
  const validSeed = seedInvalid ? undefined : seedNumber
  const selectedModelReady =
    mode === 'compare' ? compareSelection.length > 0 : model.trim() !== ''
  const canSubmit =
    !controlsDisabled &&
    !generationUnsupported &&
    selectedModelReady &&
    trimmedPrompt !== '' &&
    !seedInvalid
  let runLabel = t('Review cost and generate')
  if (mode === 'single') runLabel = t('Generate')
  if (isSubmitting) runLabel = t('Generating...')
  const pendingEstimateSteps = useMemo(
    () => (pendingPlan ? generationPlanEstimateSteps(pendingPlan) : []),
    [pendingPlan]
  )
  const batchTaskSubmitted = batch.cells.some((cell) => cell.taskId)

  const toggleCompareModel = (value: string) => {
    const current = compareSelection
    if (current.includes(value) && current.length <= 1) return
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]
    setCompareModels(
      normalizeGenerationModels(next).slice(
        0,
        PLAYGROUND_GENERATION_COMPARE_MAX
      )
    )
  }

  const handleSubmit = async () => {
    if (!canSubmit || mode !== 'single') return
    setIsSubmitting(true)
    try {
      if (kind === 'image') {
        const outcome = await generation.image.mutateAsync({
          model: model.trim(),
          prompt: trimmedPrompt,
          group: props.group,
          size: imageSize,
          ...(quality ? { quality } : {}),
          ...(validSeed !== undefined ? { seed: validSeed } : {}),
        })
        setImages(outcome.kind === 'images' ? outcome.images : [])
        setImageTaskSubmitted(outcome.kind === 'task')
        setAudioUrl(null)
      } else if (kind === 'video') {
        await generation.video.mutateAsync({
          model: model.trim(),
          prompt: trimmedPrompt,
          group: props.group,
          size: videoSize,
          duration,
          ...(validSeed !== undefined ? { seed: validSeed } : {}),
        })
        setImages([])
        setImageTaskSubmitted(false)
        setAudioUrl(null)
        // A queued video is shown by CanvasTaskQueue; a durable task appears
        // in the shared task list after the same mutation invalidates it.
      } else {
        const blob = await generation.audio.mutateAsync({
          model: model.trim(),
          text: trimmedPrompt,
          group: props.group,
          voice,
        })
        setImages([])
        setImageTaskSubmitted(false)
        setAudioUrl(URL.createObjectURL(blob))
      }
    } catch (error) {
      handleServerError(error, t(GENERATION_ERROR_KEYS[kind]))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleBatchStart = () => {
    if (!batchKind || !canSubmit) return
    const plan = buildGenerationBatchPlan({
      mode: mode === 'compare' ? 'compare' : 'variations',
      kind: batchKind,
      prompt: trimmedPrompt,
      group: props.group,
      models: planModels,
      ...(mode === 'variations' ? { variationCount, seedMode } : {}),
      baseSeed: validSeed,
      size: kind === 'image' ? imageSize : videoSize,
      ...(kind === 'image' && quality ? { quality } : {}),
      ...(kind === 'video' ? { duration } : {}),
      limits: modelLimits,
    })
    setPlanNotices(generationAdjustmentNotices(plan))
    setBlockedModels(plan.blocked)
    let planMessage = plan.errorKey ?? null
    if (!planMessage && plan.blocked.length > 0) {
      planMessage = PLAYGROUND_GENERATION_BATCH_MESSAGES.BLOCKED_MODELS
    }
    if (!planMessage && plan.requests.length === 0) {
      planMessage = PLAYGROUND_GENERATION_BATCH_MESSAGES.MODEL_REQUIRED
    }
    setPlanError(planMessage)
    if (
      plan.errorKey ||
      plan.blocked.length > 0 ||
      plan.requests.length === 0
    ) {
      setPendingPlan(null)
      return
    }
    setPendingPlan(plan)
    setBudgetOpen(true)
  }

  const handleRerun = () => {
    const lastPlan = batch.plan
    if (!lastPlan || batch.running) return
    setPlanError(null)
    setBlockedModels([])
    setPlanNotices(generationAdjustmentNotices(lastPlan))
    setPendingPlan(lastPlan)
    setBudgetOpen(true)
  }

  const handleBudgetRun = (
    budget?: CanvasWorkflowRunBudgetRef,
    _start?: { estimateQuota: number; budgetCap: number },
    estimate?: CanvasWorkflowRunEstimate
  ) => {
    const plan = pendingPlan
    if (!plan) return
    const estimates: Record<string, number> = {}
    for (const step of estimate?.steps ?? []) {
      if (step.available) estimates[step.nodeId] = step.quota
    }
    setImages([])
    setImageTaskSubmitted(false)
    setAudioUrl(null)
    setPlanError(null)
    setPendingPlan(null)
    void batch.run(plan, {
      ...(budget ? { budgetRunId: budget.runId } : {}),
      estimates,
    })
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3'>
      <section className='grid gap-2'>
        <div className='flex items-center gap-2'>
          <Sparkles aria-hidden='true' className='size-4' />
          <h3 className='text-sm font-medium'>{t('Generate media')}</h3>
        </div>

        <div
          aria-label={t('Generation type')}
          className='grid grid-cols-3 gap-1'
          role='group'
        >
          {PLAYGROUND_GENERATION_KINDS.map((option) => (
            <Button
              aria-pressed={kind === option}
              disabled={controlsDisabled}
              key={option}
              onClick={() => {
                setKind(option)
                if (option === 'audio') setMode('single')
              }}
              size='sm'
              type='button'
              variant={kind === option ? 'secondary' : 'ghost'}
            >
              {t(GENERATION_KIND_LABELS[option])}
            </Button>
          ))}
        </div>

        {kind !== 'audio' ? (
          <div
            aria-label={t('Generation mode')}
            className='grid grid-cols-3 gap-1'
            role='group'
          >
            {PLAYGROUND_GENERATION_MODES.map((option) => (
              <Button
                aria-pressed={mode === option}
                disabled={controlsDisabled}
                key={option}
                onClick={() => {
                  setMode(option)
                  setPlanError(null)
                  setPlanNotices([])
                  setBlockedModels([])
                }}
                size='sm'
                type='button'
                variant={mode === option ? 'secondary' : 'ghost'}
              >
                {t(PLAYGROUND_GENERATION_MODE_LABELS[option])}
              </Button>
            ))}
          </div>
        ) : null}

        {mode === 'compare' && kind !== 'audio' ? (
          <fieldset className='grid gap-1.5'>
            <legend className='mb-1 text-sm font-medium'>
              {t('Models to compare')}
            </legend>
            {props.models.map((option) => (
              <label
                className='flex items-center gap-2 text-sm'
                key={option.value}
              >
                <Checkbox
                  checked={compareSelection.includes(option.value)}
                  disabled={controlsDisabled}
                  onCheckedChange={() => toggleCompareModel(option.value)}
                />
                <span className='min-w-0 truncate'>{option.label}</span>
              </label>
            ))}
            <p className='text-muted-foreground text-xs'>
              {t(PLAYGROUND_GENERATION_BATCH_MESSAGES.COMPARE_SELECTION)}
            </p>
          </fieldset>
        ) : (
          <div className='grid gap-2'>
            <Label htmlFor='playground-generation-model'>{t('Model')}</Label>
            <NativeSelect
              disabled={controlsDisabled || props.models.length === 0}
              id='playground-generation-model'
              onChange={(event) => setModel(event.target.value)}
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
            {capabilityReason ? (
              <p className='text-warning text-xs'>{t(capabilityReason)}</p>
            ) : null}
          </div>
        )}

        <div className='grid gap-2'>
          <Label htmlFor='playground-generation-prompt'>{t('Prompt')}</Label>
          <Textarea
            disabled={controlsDisabled}
            id='playground-generation-prompt'
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('Describe what you want to generate')}
            rows={3}
            value={prompt}
          />
        </div>

        {kind === 'image' ? (
          <>
            <div className='grid gap-2'>
              <Label htmlFor='playground-generation-size'>{t('Size')}</Label>
              <NativeSelect
                disabled={controlsDisabled}
                id='playground-generation-size'
                onChange={(event) => setImageSize(event.target.value)}
                value={imageSize}
              >
                {sizeOptions.map((option) => (
                  <NativeSelectOption key={option} value={option}>
                    {option}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='playground-generation-quality'>
                {t('Quality')}
              </Label>
              <NativeSelect
                disabled={controlsDisabled}
                id='playground-generation-quality'
                onChange={(event) => setQuality(event.target.value)}
                value={quality}
              >
                <NativeSelectOption value=''>{t('Default')}</NativeSelectOption>
                {qualityOptions.map((option) => (
                  <NativeSelectOption key={option} value={option}>
                    {option}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </>
        ) : null}

        {kind === 'video' ? (
          <>
            <div className='grid gap-2'>
              <Label htmlFor='playground-generation-size'>{t('Size')}</Label>
              <NativeSelect
                disabled={controlsDisabled}
                id='playground-generation-size'
                onChange={(event) => setVideoSize(event.target.value)}
                value={videoSize}
              >
                {sizeOptions.map((option) => (
                  <NativeSelectOption key={option} value={option}>
                    {option}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='playground-generation-duration'>
                {t('Duration (seconds)')}
              </Label>
              <NativeSelect
                disabled={controlsDisabled}
                id='playground-generation-duration'
                onChange={(event) => setDuration(Number(event.target.value))}
                value={String(duration)}
              >
                {durationOptions.map((option) => (
                  <NativeSelectOption key={option} value={String(option)}>
                    {option}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </>
        ) : null}

        {kind === 'audio' ? (
          <div className='grid gap-2'>
            <Label htmlFor='playground-generation-voice'>{t('Voice')}</Label>
            <NativeSelect
              disabled={controlsDisabled}
              id='playground-generation-voice'
              onChange={(event) => setVoice(event.target.value)}
              value={voice}
            >
              {PLAYGROUND_AUDIO_VOICES.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {option}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {kind !== 'audio' ? (
          <div className='grid grid-cols-2 gap-2'>
            <div className='grid gap-2'>
              <Label htmlFor='playground-generation-seed'>
                {mode === 'variations' ? t('Base seed') : t('Seed')}
              </Label>
              <Input
                disabled={controlsDisabled}
                id='playground-generation-seed'
                inputMode='numeric'
                max={PLAYGROUND_GENERATION_SEED_MAX}
                min={PLAYGROUND_GENERATION_SEED_MIN}
                onChange={(event) => setSeed(event.target.value)}
                placeholder={t('Random')}
                type='number'
                value={seed}
              />
            </div>
            {mode === 'variations' ? (
              <div className='grid gap-2'>
                <Label htmlFor='playground-generation-variation-count'>
                  {t('Number of variations')}
                </Label>
                <NativeSelect
                  disabled={controlsDisabled}
                  id='playground-generation-variation-count'
                  onChange={(event) =>
                    setVariationCount(
                      clampGenerationVariationCount(Number(event.target.value))
                    )
                  }
                  value={String(variationCount)}
                >
                  {Array.from(
                    { length: PLAYGROUND_GENERATION_VARIATION_MAX },
                    (_, index) => index + 1
                  ).map((option) => (
                    <NativeSelectOption key={option} value={String(option)}>
                      {option}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
          </div>
        ) : null}

        {kind !== 'audio' && mode === 'variations' ? (
          <div className='grid gap-2'>
            <Label htmlFor='playground-generation-seed-mode'>
              {t('Seed mode')}
            </Label>
            <NativeSelect
              disabled={controlsDisabled}
              id='playground-generation-seed-mode'
              onChange={(event) =>
                setSeedMode(event.target.value as GenerationSeedMode)
              }
              value={seedMode}
            >
              {PLAYGROUND_GENERATION_SEED_MODES.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {t(option === 'increment' ? 'Increment' : 'Random')}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {seedInvalid ? (
          <p className='text-destructive text-xs'>
            {t(PLAYGROUND_GENERATION_BATCH_MESSAGES.SEED_INVALID)}
          </p>
        ) : null}

        {batch.running ? (
          <Button onClick={batch.stop} type='button' variant='destructive'>
            <Square aria-hidden='true' data-icon='inline-start' />
            {t('Stop')}
          </Button>
        ) : (
          <div className='flex flex-wrap gap-2'>
            <Button
              disabled={!canSubmit}
              onClick={() =>
                void (mode === 'single' ? handleSubmit() : handleBatchStart())
              }
              type='button'
            >
              {isSubmitting ? (
                <Loader2 aria-hidden='true' className='animate-spin' />
              ) : null}
              {runLabel}
            </Button>
            {kind !== 'audio' && mode !== 'single' && batch.plan ? (
              <Button
                disabled={props.disabled || isSubmitting}
                onClick={handleRerun}
                type='button'
                variant='outline'
              >
                <RotateCcw aria-hidden='true' data-icon='inline-start' />
                {t('Re-run with same params')}
              </Button>
            ) : null}
          </div>
        )}

        {kind !== 'audio' && mode !== 'single' ? (
          <p className='text-muted-foreground text-xs'>
            {t(PLAYGROUND_GENERATION_BATCH_MESSAGES.BATCH_CONCURRENCY, {
              count: PLAYGROUND_GENERATION_BATCH_CONCURRENCY,
            })}
          </p>
        ) : null}

        {planError ? (
          <p className='text-destructive text-xs' role='alert'>
            {t(planError)}
          </p>
        ) : null}
        {blockedModels.map((blocked) => (
          <p
            className='text-destructive text-xs'
            key={blocked.model}
            role='alert'
          >
            {t(blocked.messageKey)}
          </p>
        ))}
        {planNotices.map((notice) => (
          <p
            className='text-xs text-amber-600'
            key={`${notice.messageKey}-${notice.values.model}-${notice.values.from}-${notice.values.to}`}
          >
            {t(notice.messageKey, notice.values)}
          </p>
        ))}
      </section>

      {imageTaskSubmitted ? (
        <p className='text-muted-foreground text-sm' role='status'>
          {t(
            'Image generation submitted as a task; the result appears in the task list.'
          )}
        </p>
      ) : null}

      {images.length > 0 ? (
        <section aria-label={t('Generated media')} className='grid gap-2'>
          {images.map((image, index) => {
            const source =
              image.url ??
              (image.b64Json ? `data:image/png;base64,${image.b64Json}` : '')
            if (!source) return null
            return (
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
            )
          })}
        </section>
      ) : null}

      {audioUrl ? (
        <section className='grid gap-2'>
          <audio
            aria-label={t('Generated audio')}
            className='w-full'
            controls
            src={audioUrl}
          />
        </section>
      ) : null}

      {kind !== 'audio' && batch.cells.length > 0 ? (
        <section className='grid gap-2'>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-sm font-medium'>{t('Batch results')}</h3>
            <span className='text-muted-foreground text-xs'>
              {t('Total requests: {{total}}', { total: batch.cells.length })}
            </span>
          </div>
          <CanvasGenerationResults
            cells={batch.cells}
            tasks={tasksQuery.data}
          />
          {batchTaskSubmitted ? (
            <p className='text-muted-foreground text-sm' role='status'>
              {t(
                'Image generation submitted as a task; the result appears in the task list.'
              )}
            </p>
          ) : null}
          {batch.stopped ? (
            <p className='text-muted-foreground text-sm' role='status'>
              {t(PLAYGROUND_GENERATION_ERRORS.BATCH_STOPPED)}
            </p>
          ) : null}
          {batch.budgetSettleFailed ? (
            <p className='text-destructive text-sm' role='status'>
              {t(
                'The batch finished, but its run budget could not be settled.'
              )}
            </p>
          ) : null}
        </section>
      ) : null}

      <CanvasTaskQueue />

      <section className='grid gap-2'>
        <h3 className='text-sm font-medium'>{t('Generation tasks')}</h3>
        <CanvasTaskList
          active={props.active}
          onSendToCanvas={props.onSendToCanvas}
        />
      </section>

      <CanvasRunBudgetDialog
        confirmLabel={t('Generate batch')}
        description={t(
          'Review the estimated cost of these media requests before the batch starts.'
        )}
        group={props.group}
        onOpenChange={(open) => {
          setBudgetOpen(open)
          if (!open) setPendingPlan(null)
        }}
        onRun={handleBudgetRun}
        open={budgetOpen}
        steps={pendingEstimateSteps}
        title={t('Review batch cost')}
      />
    </div>
  )
}
