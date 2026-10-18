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
import { ImageIcon, Plus, Send, Square, Video } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Loader } from '@/components/ai-elements/loader'
import { Message, MessageContent } from '@/components/ai-elements/message'
import { Response } from '@/components/ai-elements/response'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import type { ModelOption } from '@/features/playground/types'
import { translateServerText } from '@/lib/server-error-message'

import {
  CANVAS_ASSISTANT_INPUT_MAX_CHARS,
  CANVAS_ASSISTANT_MESSAGES,
  CANVAS_ASSISTANT_MODES,
  CANVAS_ASSISTANT_MODE_LABELS,
  CANVAS_ASSISTANT_REPLY_LABELS,
} from '../constants'
import type { CanvasAssistantMessage } from '../hooks/use-canvas-assistant'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import type { CanvasAssistantMode } from '../types'

const CANVAS_ASSISTANT_REPLY_ICONS = {
  chat: Plus,
  image: ImageIcon,
  video: Video,
} as const

interface CanvasAssistantPanelProps {
  disabled?: boolean
  mode: CanvasAssistantMode
  model: string
  models: ModelOption[]
  messages: CanvasAssistantMessage[]
  /** A reply is streaming; the composer offers stop instead of send. */
  streaming: boolean
  contextCount: number
  /** Label of the node the context starts from; null when none is selected. */
  anchorLabel: string | null
  /** Whether a generation step can be linked to a selected node. */
  canGenerate: boolean
  workflowPhase: CanvasWorkflowRunPhase
  onModeChange: (mode: CanvasAssistantMode) => void
  onModelChange: (model: string) => void
  onSend: (text: string) => void
  onStop: () => void
  onInsertReply: (message: CanvasAssistantMessage) => void
  onGenerate: (message: CanvasAssistantMessage) => void
}

/**
 * The canvas assistant sidebar: a chat over the selected node and its upstream
 * chain, with the composer reusing the Playground streaming request. Every
 * settled reply offers one action - insert it as a text node, or, in the
 * image/video modes, turn it into a generation step.
 */
export function CanvasAssistantPanel(props: CanvasAssistantPanelProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const ready = !props.disabled && !props.streaming && props.model !== ''
  const canSend = ready && draft.trim() !== ''
  const canGenerateReply =
    ready && props.canGenerate && props.workflowPhase !== 'running'
  const ReplyIcon = CANVAS_ASSISTANT_REPLY_ICONS[props.mode]

  const submit = () => {
    if (!canSend) return
    props.onSend(draft.trim())
    setDraft('')
  }

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='space-y-2 border-b p-3'>
        <div className='flex items-center gap-2'>
          <NativeSelect
            aria-label={t('Assistant mode')}
            className='w-24 shrink-0'
            disabled={props.disabled || props.streaming}
            onChange={(event) =>
              props.onModeChange(event.target.value as CanvasAssistantMode)
            }
            size='sm'
            value={props.mode}
          >
            {CANVAS_ASSISTANT_MODES.map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {t(CANVAS_ASSISTANT_MODE_LABELS[mode])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={t('Model')}
            className='min-w-0 flex-1'
            disabled={
              props.disabled || props.streaming || props.models.length === 0
            }
            onChange={(event) => props.onModelChange(event.target.value)}
            size='sm'
            value={props.model}
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

        <p className='text-muted-foreground text-xs'>
          {props.anchorLabel
            ? t('Selected node: {{label}} · {{count}} nodes in context', {
                label: props.anchorLabel,
                count: props.contextCount,
              })
            : t('Whole canvas · {{count}} nodes in context', {
                count: props.contextCount,
              })}
        </p>

        {props.mode !== 'chat' && !props.canGenerate ? (
          <p className='text-muted-foreground text-xs'>
            {t(CANVAS_ASSISTANT_MESSAGES.ANCHOR_REQUIRED)}
          </p>
        ) : null}
      </div>

      <Conversation className='min-h-0 flex-1'>
        <ConversationContent className='gap-3 p-3'>
          {props.messages.length === 0 ? (
            <ConversationEmptyState
              description={t(
                'Ask about the canvas, refine its text, or compose a generation instruction.'
              )}
              title={t('Canvas assistant')}
            />
          ) : (
            props.messages.map((message) => {
              const streamingReply =
                message.status === 'streaming' && message.content === ''
              const failedReply =
                message.role === 'assistant' && message.status === 'error'
              const insertable =
                message.role === 'assistant' &&
                message.status === 'done' &&
                message.content.trim() !== ''
              let body: ReactNode
              if (message.role === 'user') {
                body = <p className='whitespace-pre-wrap'>{message.content}</p>
              } else if (streamingReply) {
                body = (
                  <span className='flex items-center gap-2 py-1'>
                    <Loader />
                    <Shimmer className='text-sm' duration={1}>
                      {t('Responding...')}
                    </Shimmer>
                  </span>
                )
              } else {
                body = (
                  <Response final={message.status !== 'streaming'}>
                    {message.content}
                  </Response>
                )
              }
              return (
                <Message from={message.role} key={message.id}>
                  <MessageContent
                    variant={message.role === 'user' ? 'contained' : 'flat'}
                  >
                    {body}

                    {failedReply ? (
                      <p className='text-destructive text-xs'>
                        {translateServerText(
                          t,
                          message.error?.trim() ||
                            CANVAS_ASSISTANT_MESSAGES.REQUEST_FAILED
                        )}
                      </p>
                    ) : null}

                    {insertable ? (
                      <div className='flex justify-end'>
                        <Button
                          disabled={
                            props.disabled ||
                            (props.mode !== 'chat' && !canGenerateReply)
                          }
                          onClick={() => {
                            if (props.mode === 'chat') {
                              props.onInsertReply(message)
                            } else {
                              props.onGenerate(message)
                            }
                          }}
                          size='sm'
                          type='button'
                          variant='outline'
                        >
                          <ReplyIcon aria-hidden='true' />
                          {t(CANVAS_ASSISTANT_REPLY_LABELS[props.mode])}
                        </Button>
                      </div>
                    ) : null}
                  </MessageContent>
                </Message>
              )
            })
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className='space-y-2 border-t p-3'>
        <Textarea
          aria-label={t('Ask the assistant')}
          className='min-h-20'
          disabled={props.disabled || props.streaming}
          maxLength={CANVAS_ASSISTANT_INPUT_MAX_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            ) {
              return
            }
            event.preventDefault()
            submit()
          }}
          placeholder={t('Ask the assistant')}
          value={draft}
        />
        <div className='flex justify-end'>
          {props.streaming ? (
            <Button
              onClick={props.onStop}
              size='sm'
              type='button'
              variant='destructive'
            >
              <Square aria-hidden='true' />
              {t('Stop')}
            </Button>
          ) : (
            <Button
              disabled={!canSend}
              onClick={submit}
              size='sm'
              type='button'
            >
              <Send aria-hidden='true' />
              {t('Send')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
