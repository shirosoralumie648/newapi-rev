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
import { Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import type { CanvasSendSeed } from '@/features/canvas/lib/canvas-send'
import {
  PLAYGROUND_AUDIO_VOICES,
  PLAYGROUND_GENERATION_ERRORS,
  PLAYGROUND_GENERATION_KINDS,
  PLAYGROUND_IMAGE_SIZES,
  PLAYGROUND_VIDEO_DURATIONS,
} from '@/features/playground/constants'
import type { PlaygroundImageResult } from '@/features/playground/generation-api'
import { usePlaygroundGeneration } from '@/features/playground/hooks'
import type {
  ModelOption,
  PlaygroundGenerationKind,
} from '@/features/playground/types'
import { handleServerError } from '@/lib/handle-server-error'

import { CanvasTaskList } from './canvas-task-list'

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

interface CanvasGenerationPanelProps {
  active: boolean
  disabled?: boolean
  group: string
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
 */
export function CanvasGenerationPanel(props: CanvasGenerationPanelProps) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<PlaygroundGenerationKind>(
    props.initialKind ?? 'image'
  )
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState(props.initialPrompt ?? '')
  const [size, setSize] = useState<string>(PLAYGROUND_IMAGE_SIZES[0])
  const [duration, setDuration] = useState<number>(
    PLAYGROUND_VIDEO_DURATIONS[0]
  )
  const [voice, setVoice] = useState<string>(PLAYGROUND_AUDIO_VOICES[0])
  const [images, setImages] = useState<PlaygroundImageResult[]>([])
  const [imageTaskSubmitted, setImageTaskSubmitted] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const generation = usePlaygroundGeneration()

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
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  const trimmedPrompt = prompt.trim()
  const canSubmit =
    !props.disabled &&
    !isSubmitting &&
    model.trim() !== '' &&
    trimmedPrompt !== ''

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      if (kind === 'image') {
        const outcome = await generation.image.mutateAsync({
          model: model.trim(),
          prompt: trimmedPrompt,
          group: props.group,
          size,
        })
        setImages(outcome.kind === 'images' ? outcome.images : [])
        setImageTaskSubmitted(outcome.kind === 'task')
        setAudioUrl(null)
      } else if (kind === 'video') {
        await generation.video.mutateAsync({
          model: model.trim(),
          prompt: trimmedPrompt,
          group: props.group,
          duration,
        })
        setImages([])
        setImageTaskSubmitted(false)
        setAudioUrl(null)
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
              disabled={props.disabled}
              key={option}
              onClick={() => setKind(option)}
              size='sm'
              type='button'
              variant={kind === option ? 'secondary' : 'ghost'}
            >
              {t(GENERATION_KIND_LABELS[option])}
            </Button>
          ))}
        </div>

        <div className='grid gap-2'>
          <Label htmlFor='playground-generation-model'>{t('Model')}</Label>
          <NativeSelect
            disabled={props.disabled || props.models.length === 0}
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
        </div>

        <div className='grid gap-2'>
          <Label htmlFor='playground-generation-prompt'>{t('Prompt')}</Label>
          <Textarea
            disabled={props.disabled}
            id='playground-generation-prompt'
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('Describe what you want to generate')}
            rows={3}
            value={prompt}
          />
        </div>

        {kind === 'image' ? (
          <div className='grid gap-2'>
            <Label htmlFor='playground-generation-size'>{t('Size')}</Label>
            <NativeSelect
              disabled={props.disabled}
              id='playground-generation-size'
              onChange={(event) => setSize(event.target.value)}
              value={size}
            >
              {PLAYGROUND_IMAGE_SIZES.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {option}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {kind === 'video' ? (
          <div className='grid gap-2'>
            <Label htmlFor='playground-generation-duration'>
              {t('Duration (seconds)')}
            </Label>
            <NativeSelect
              disabled={props.disabled}
              id='playground-generation-duration'
              onChange={(event) => setDuration(Number(event.target.value))}
              value={String(duration)}
            >
              {PLAYGROUND_VIDEO_DURATIONS.map((option) => (
                <NativeSelectOption key={option} value={String(option)}>
                  {option}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {kind === 'audio' ? (
          <div className='grid gap-2'>
            <Label htmlFor='playground-generation-voice'>{t('Voice')}</Label>
            <NativeSelect
              disabled={props.disabled}
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

        <Button
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          type='button'
        >
          {isSubmitting ? (
            <Loader2 aria-hidden='true' className='animate-spin' />
          ) : null}
          {isSubmitting ? t('Generating...') : t('Generate')}
        </Button>
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

      <section className='grid gap-2'>
        <h3 className='text-sm font-medium'>{t('Generation tasks')}</h3>
        <CanvasTaskList
          active={props.active}
          onSendToCanvas={props.onSendToCanvas}
        />
      </section>
    </div>
  )
}
