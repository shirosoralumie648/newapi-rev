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
import { MicIcon, SquareIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { handleServerError } from '@/lib/handle-server-error'

import {
  PLAYGROUND_DICTATION_ERRORS,
  PLAYGROUND_DICTATION_MAX_SECONDS,
} from '../../constants'
import { usePlaygroundTranscription } from '../../hooks'
import type { ModelOption } from '../../types'

// Recording filenames by media type. Browsers pick the container (WebM in
// Chromium, MP4 in Safari), so the clip travels under the name it was recorded
// with and the upstream model decides whether it can decode it.
const DICTATION_FILENAMES: Record<string, string> = {
  'audio/webm': 'dictation.webm',
  'audio/ogg': 'dictation.ogg',
  'audio/mp4': 'dictation.m4a',
  'audio/mpeg': 'dictation.mp3',
  'audio/wav': 'dictation.wav',
}

interface PlaygroundDictationPanelProps {
  disabled?: boolean
  group: string
  models: ModelOption[]
  /** Inserts an accepted transcript into the composer. */
  onTranscript: (text: string) => void
}

/**
 * Records a clip with the microphone and inserts its transcript into the
 * composer. The clip is transcribed through the /pg transcription bridge, so
 * the relay bills it like any other request; nothing is stored on the
 * conversation, only the returned text is used.
 */
export function PlaygroundDictationPanel(props: PlaygroundDictationPanelProps) {
  const { t } = useTranslation()
  const transcription = usePlaygroundTranscription()
  const [model, setModel] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const stopTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const firstModel = props.models[0]?.value ?? ''
    if (!model && firstModel) setModel(firstModel)
  }, [model, props.models])

  // A panel that goes away never leaves the microphone live.
  useEffect(() => {
    return () => {
      if (stopTimerRef.current !== null) {
        window.clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onstop = null
        if (recorder.state !== 'inactive') recorder.stop()
      }
      mediaRecorderRef.current = null
      const stream = streamRef.current
      streamRef.current = null
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const transcribe = async (blob: Blob, mimeType: string) => {
    if (blob.size === 0) {
      toast.warning(t(PLAYGROUND_DICTATION_ERRORS.EMPTY))
      return
    }
    const baseType = mimeType.split(';')[0]
    try {
      const text = await transcription.mutateAsync({
        model: model.trim(),
        group: props.group,
        file: blob,
        filename: DICTATION_FILENAMES[baseType] ?? 'dictation.webm',
      })
      const trimmed = text.trim()
      if (!trimmed) {
        toast.warning(t(PLAYGROUND_DICTATION_ERRORS.EMPTY))
        return
      }
      props.onTranscript(trimmed)
    } catch (error) {
      handleServerError(
        error,
        t(PLAYGROUND_DICTATION_ERRORS.TRANSCRIPTION_FAILED)
      )
    }
  }

  const finishRecording = (recorder: MediaRecorder) => {
    const mimeType = recorder.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type: mimeType })
    chunksRef.current = []
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setIsRecording(false)
    void transcribe(blob, mimeType)
  }

  const startRecording = async () => {
    if (props.disabled || transcription.isPending) return
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      toast.error(t(PLAYGROUND_DICTATION_ERRORS.UNSUPPORTED))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => finishRecording(recorder)
      recorder.start()
      mediaRecorderRef.current = recorder
      streamRef.current = stream
      setIsRecording(true)
      // A recording is bounded so a forgotten panel cannot accumulate an
      // arbitrarily large clip in memory.
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = null
        const active = mediaRecorderRef.current
        if (active && active.state === 'recording') active.stop()
      }, PLAYGROUND_DICTATION_MAX_SECONDS * 1000)
    } catch {
      toast.error(t(PLAYGROUND_DICTATION_ERRORS.MICROPHONE_FAILED))
    }
  }

  const stopRecording = () => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state === 'recording') recorder.stop()
  }

  const trigger = (
    <PromptInputButton
      aria-label={t('Dictation')}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <MicIcon size={16} />
    </PromptInputButton>
  )

  let recordButtonLabel = t('Start dictation')
  if (isRecording) recordButtonLabel = t('Stop dictation')
  else if (transcription.isPending) recordButtonLabel = t('Transcribing...')

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Dictation')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='w-[20rem] max-w-[calc(100vw-2rem)] gap-3 p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        <div className='space-y-1 px-1'>
          <div className='text-sm font-semibold'>{t('Dictation')}</div>
          <div className='text-muted-foreground text-xs leading-4'>
            {t(
              'Record your voice and insert the transcript into the composer.'
            )}
          </div>
        </div>

        <div className='grid gap-2'>
          <Label htmlFor='playground-dictation-model'>{t('Model')}</Label>
          <NativeSelect
            disabled={
              props.disabled ||
              isRecording ||
              transcription.isPending ||
              props.models.length === 0
            }
            id='playground-dictation-model'
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

        <Button
          disabled={
            props.disabled || transcription.isPending || model.trim() === ''
          }
          onClick={() => {
            if (isRecording) {
              stopRecording()
              return
            }
            void startRecording()
          }}
          type='button'
          variant={isRecording ? 'destructive' : 'default'}
        >
          {isRecording ? (
            <SquareIcon aria-hidden='true' />
          ) : (
            <MicIcon aria-hidden='true' />
          )}
          {recordButtonLabel}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
