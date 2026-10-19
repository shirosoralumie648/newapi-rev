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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { estimateCanvasWorkflowRun } from '@/features/canvas/api'
import type { CanvasWorkflowRunEstimate } from '@/features/canvas/api'
import { formatLogQuota, parseQuotaFromDollars } from '@/lib/format'
import { getServerErrorMessage } from '@/lib/server-error-message'

import {
  PLAYGROUND_COMPARISON_DEFAULT_CONCURRENCY,
  PLAYGROUND_COMPARISON_MAX_CONCURRENCY,
  PLAYGROUND_COMPARISON_MAX_MODELS,
  PLAYGROUND_COMPARISON_MAX_PROMPTS,
  PLAYGROUND_COMPARISON_MESSAGES,
  PLAYGROUND_COMPARISON_MIN_MODELS,
  PLAYGROUND_COMPARISON_PROMPT_MAX_BYTES,
  PLAYGROUND_COMPARISON_TITLE_MAX_LENGTH,
} from '../../constants'
import type { StartPlaygroundComparisonRunInput } from '../../hooks/use-playground-comparison-runner'
import {
  buildComparisonEstimateSteps,
  isChatModelOption,
  normalizeComparisonModels,
  parseComparisonPrompts,
} from '../../lib'
import type { ModelOption, PlaygroundComparisonStrategy } from '../../types'

interface PlaygroundComparisonFormProps {
  disabled?: boolean
  /** Group every cell of the run is sent with; the estimate prices it too. */
  group: string
  /** Composer's parallel selection, seeded when the dialog opens. */
  initialModels: string[]
  models: ModelOption[]
  open: boolean
  onStart: (input: StartPlaygroundComparisonRunInput) => Promise<boolean>
  onStop: () => void
  running: boolean
}

function defaultConcurrency(): string {
  return String(
    Math.min(
      PLAYGROUND_COMPARISON_DEFAULT_CONCURRENCY,
      PLAYGROUND_COMPARISON_MAX_CONCURRENCY
    )
  )
}

/**
 * New-run form of the compare workbench. It parses the prompt editor, bounds
 * the model selection, prices the whole matrix through BL-03's estimate
 * endpoint before anything is sent and optionally opens one run budget. It
 * never charges quota itself: every cell remains an ordinary `/pg` request.
 */
export function PlaygroundComparisonForm(props: PlaygroundComparisonFormProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [promptText, setPromptText] = useState('')
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [strategy, setStrategy] =
    useState<PlaygroundComparisonStrategy>('serial')
  const [concurrency, setConcurrency] = useState(defaultConcurrency)
  const [cap, setCap] = useState('')
  const [estimate, setEstimate] = useState<CanvasWorkflowRunEstimate | null>(
    null
  )
  const [estimating, setEstimating] = useState(false)
  const [starting, setStarting] = useState(false)
  const [estimateError, setEstimateError] = useState('')
  const [error, setError] = useState('')

  const chatModels = props.models.filter(isChatModelOption)

  // Opening the dialog seeds the selection from the composer's compare models
  // while keeping a draft the user already configured in an earlier opening.
  useEffect(() => {
    if (!props.open) return
    const available = new Set(chatModels.map((model) => model.value))
    setSelectedModels((current) => {
      const usable = current.filter((model) => available.has(model))
      if (usable.length >= PLAYGROUND_COMPARISON_MIN_MODELS) return usable
      return normalizeComparisonModels(
        props.initialModels.filter((model) => available.has(model))
      )
    })
    // `chatModels` is derived from the models prop on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initialModels, props.models])

  // Any input change invalidates the displayed price, so a stale total never
  // authorizes a different matrix than the one the server priced.
  useEffect(() => {
    setEstimate(null)
    setEstimateError('')
  }, [promptText, selectedModels])

  const trimmedCap = cap.trim()
  const capQuota = trimmedCap ? parseQuotaFromDollars(Number(trimmedCap)) : 0
  const capInvalid = trimmedCap !== '' && capQuota <= 0

  const readPrompts = (): { prompts: string[]; error: string } => {
    const parsed = parseComparisonPrompts(promptText)
    if (parsed.invalidLines.length > 0) {
      return {
        prompts: [],
        error: t(PLAYGROUND_COMPARISON_MESSAGES.PROMPTS_INVALID, {
          line: parsed.invalidLines[0],
        }),
      }
    }
    if (parsed.prompts.length === 0) {
      return {
        prompts: [],
        error: t(PLAYGROUND_COMPARISON_MESSAGES.PROMPTS_EMPTY),
      }
    }
    if (parsed.prompts.length > PLAYGROUND_COMPARISON_MAX_PROMPTS) {
      return {
        prompts: [],
        error: t(PLAYGROUND_COMPARISON_MESSAGES.PROMPTS_LIMIT, {
          count: PLAYGROUND_COMPARISON_MAX_PROMPTS,
        }),
      }
    }
    const encoder = new TextEncoder()
    if (
      parsed.prompts.some(
        (prompt) =>
          encoder.encode(prompt).length > PLAYGROUND_COMPARISON_PROMPT_MAX_BYTES
      )
    ) {
      return {
        prompts: [],
        error: t(PLAYGROUND_COMPARISON_MESSAGES.PROMPT_TOO_LARGE),
      }
    }
    return { prompts: parsed.prompts, error: '' }
  }

  const modelsError =
    selectedModels.length < PLAYGROUND_COMPARISON_MIN_MODELS ||
    selectedModels.length > PLAYGROUND_COMPARISON_MAX_MODELS
      ? t(PLAYGROUND_COMPARISON_MESSAGES.MODELS_LIMIT, {
          min: PLAYGROUND_COMPARISON_MIN_MODELS,
          max: PLAYGROUND_COMPARISON_MAX_MODELS,
        })
      : ''

  const priceMatrix = async (
    models: string[],
    prompts: string[]
  ): Promise<CanvasWorkflowRunEstimate | null> => {
    setEstimating(true)
    setEstimateError('')
    try {
      const priced = await estimateCanvasWorkflowRun(
        props.group,
        buildComparisonEstimateSteps(models, prompts, props.group)
      )
      setEstimate(priced)
      return priced
    } catch (caught: unknown) {
      setEstimateError(
        getServerErrorMessage(
          caught,
          PLAYGROUND_COMPARISON_MESSAGES.ESTIMATE_FAILED
        )
      )
      return null
    } finally {
      setEstimating(false)
    }
  }

  const handleEstimate = async () => {
    const parsed = readPrompts()
    if (parsed.error || modelsError) {
      setError(parsed.error || modelsError)
      return
    }
    setError('')
    await priceMatrix(selectedModels, parsed.prompts)
  }

  const handleStart = async () => {
    if (props.running || starting) return
    const parsed = readPrompts()
    if (parsed.error || modelsError) {
      setError(parsed.error || modelsError)
      return
    }
    if (capInvalid) return
    setError('')
    setStarting(true)
    try {
      const priced =
        estimate ?? (await priceMatrix(selectedModels, parsed.prompts))
      if (!priced) return
      const activeStrategy = strategy === 'serial' ? 'serial' : 'concurrent'
      const activeConcurrency =
        activeStrategy === 'serial'
          ? 1
          : Math.max(
              1,
              Math.min(
                Number(concurrency) ||
                  PLAYGROUND_COMPARISON_DEFAULT_CONCURRENCY,
                PLAYGROUND_COMPARISON_MAX_CONCURRENCY
              )
            )
      await props.onStart({
        title: title.trim() || undefined,
        group: props.group,
        models: selectedModels,
        prompts: parsed.prompts,
        strategy: activeStrategy,
        concurrency: activeConcurrency,
        estimateQuota: priced.totalQuota,
        budgetCap: capQuota,
      })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className='grid gap-4'>
      <div className='grid gap-1.5'>
        <Label htmlFor='pgc-title'>{t('Run title (optional)')}</Label>
        <Input
          disabled={props.running}
          id='pgc-title'
          maxLength={PLAYGROUND_COMPARISON_TITLE_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('{{models}} models x {{prompts}} prompts', {
            models: selectedModels.length,
            prompts: parseComparisonPrompts(promptText).prompts.length,
          })}
          value={title}
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='pgc-prompts'>{t('Prompts')}</Label>
        <Textarea
          disabled={props.running}
          id='pgc-prompts'
          onChange={(event) => setPromptText(event.target.value)}
          placeholder={t('One prompt per line, or one JSONL object per line.')}
          rows={5}
          value={promptText}
        />
        <p className='text-muted-foreground text-xs'>
          {t('{{count}} of {{limit}} prompts', {
            count: parseComparisonPrompts(promptText).prompts.length,
            limit: PLAYGROUND_COMPARISON_MAX_PROMPTS,
          })}
        </p>
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='pgc-models'>{t('Models')}</Label>
        <MultiSelect
          allowCreate={false}
          className='w-full'
          disabled={props.running}
          id='pgc-models'
          maxVisibleChips={3}
          onChange={(values) =>
            setSelectedModels(normalizeComparisonModels(values))
          }
          options={chatModels.map((model) => ({
            label: model.label,
            value: model.value,
          }))}
          placeholder={t('Models to compare')}
          selected={selectedModels}
        />
        <p className='text-muted-foreground text-xs'>
          {t('Pick {{min}} to {{max}} chat models.', {
            min: PLAYGROUND_COMPARISON_MIN_MODELS,
            max: PLAYGROUND_COMPARISON_MAX_MODELS,
          })}
        </p>
      </div>

      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='grid gap-1.5'>
          <span className='text-sm font-medium'>{t('Execution order')}</span>
          <RadioGroup
            aria-label={t('Execution order')}
            className='flex flex-wrap gap-3'
            onValueChange={(value) => {
              if (value === 'serial' || value === 'concurrent') {
                setStrategy(value)
              }
            }}
            value={strategy}
          >
            <Label className='font-normal' htmlFor='pgc-strategy-serial'>
              <RadioGroupItem id='pgc-strategy-serial' value='serial' />
              {t('One at a time')}
            </Label>
            <Label className='font-normal' htmlFor='pgc-strategy-concurrent'>
              <RadioGroupItem id='pgc-strategy-concurrent' value='concurrent' />
              {t('Bounded concurrency')}
            </Label>
          </RadioGroup>
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='pgc-concurrency'>{t('Concurrent requests')}</Label>
          <Input
            disabled={props.running || strategy === 'serial'}
            id='pgc-concurrency'
            inputMode='numeric'
            max={PLAYGROUND_COMPARISON_MAX_CONCURRENCY}
            min={1}
            onChange={(event) => setConcurrency(event.target.value)}
            type='number'
            value={concurrency}
          />
        </div>
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='pgc-budget-cap'>{t('Run budget cap (optional)')}</Label>
        <Input
          aria-invalid={capInvalid}
          disabled={props.running}
          id='pgc-budget-cap'
          inputMode='decimal'
          onChange={(event) => setCap(event.target.value)}
          value={cap}
        />
        <p className='text-muted-foreground text-xs'>
          {t(
            'Caps what this run may reserve from your wallet; the unspent part is returned after the run.'
          )}
        </p>
        {capInvalid && (
          <p className='text-destructive text-xs'>
            {t('Enter an amount greater than zero.')}
          </p>
        )}
        {!capInvalid &&
          capQuota > 0 &&
          estimate &&
          estimate.totalQuota > capQuota && (
            <p className='text-xs text-amber-600'>
              {t(PLAYGROUND_COMPARISON_MESSAGES.BELOW_ESTIMATE)}
            </p>
          )}
      </div>

      <div className='grid gap-2 rounded-md border p-3'>
        <div className='flex items-center justify-between gap-3'>
          <span className='text-sm font-medium'>{t('Estimated cost')}</span>
          <span className='text-sm tabular-nums'>
            {estimate
              ? formatLogQuota(estimate.totalQuota)
              : t('Not estimated yet')}
          </span>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            disabled={props.running || estimating || starting}
            onClick={() => void handleEstimate()}
            size='sm'
            type='button'
            variant='outline'
          >
            {estimating && <Spinner aria-hidden='true' />}
            {t('Estimate cost')}
          </Button>
          {estimate && !estimate.available && (
            <p className='text-muted-foreground text-xs'>
              {t(PLAYGROUND_COMPARISON_MESSAGES.UNAVAILABLE)}
            </p>
          )}
          {estimate && estimate.steps.some((step) => step.approximate) && (
            <p className='text-muted-foreground text-xs'>
              {t(PLAYGROUND_COMPARISON_MESSAGES.APPROXIMATE)}
            </p>
          )}
        </div>
        {estimateError && (
          <p className='text-destructive text-xs' role='alert'>
            {t(estimateError)}
          </p>
        )}
      </div>

      {error && (
        <p className='text-destructive text-sm' role='alert'>
          {error}
        </p>
      )}

      <div className='flex flex-wrap items-center justify-end gap-2 border-t pt-3'>
        {props.running ? (
          <Button onClick={props.onStop} type='button' variant='destructive'>
            {t('Stop run')}
          </Button>
        ) : (
          <Button
            disabled={props.disabled || estimating || starting}
            onClick={() => void handleStart()}
            type='button'
          >
            {starting && <Spinner aria-hidden='true' />}
            {t('Run comparison')}
          </Button>
        )}
      </div>
    </div>
  )
}
