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
import type { ToolUIPart } from 'ai'
import { Play } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { Loader } from '@/components/ai-elements/loader'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

import {
  PLAYGROUND_TOOL_CALL_RESULT_MAX_CHARS,
  TOOL_CALL_FAILED_CONTENT,
  TOOL_CALL_STATUS,
} from '../../constants'
import { canContinueToolCalls, getCurrentVersion } from '../../lib'
import { toolCallExecutionKey } from '../../lib/tools/tool-execution'
import type {
  Message,
  MessageToolCall,
  MessageToolCallStatus,
  MessageVersion,
} from '../../types'

type ToolCallUiState =
  | 'approval-requested'
  | 'approval-responded'
  | 'input-available'
  | 'output-denied'
  | 'output-available'
  | 'output-error'

// Stored statuses mapped onto the ai-elements tool states. Nothing here
// executes the call; the states only describe the user-provided result.
const TOOL_CALL_UI_STATES: Record<MessageToolCallStatus, ToolCallUiState> = {
  pending: 'approval-requested',
  completed: 'output-available',
  denied: 'output-denied',
  error: 'output-error',
}

// Arguments stay raw text until shown; parse them for a readable preview and
// fall back to the raw string when the model produced invalid JSON.
function parseToolCallArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments)
  } catch {
    return rawArguments
  }
}

type MessageToolCallsProps = {
  /** Calls being answered by the automatic tool loop right now. */
  executingToolCallKeys?: ReadonlySet<string>
  /** Calls the automatic tool loop answered during this mount. */
  autoFilledToolCallKeys?: ReadonlySet<string>
  isGenerating?: boolean
  isLastMessage?: boolean
  message: Message
  onContinue?: (message: Message) => void
  onDeny?: (message: Message, toolCallId: string) => void
  onProvideResult?: (
    message: Message,
    toolCallId: string,
    result: string
  ) => void
  version: MessageVersion
}

export function MessageToolCalls(props: MessageToolCallsProps) {
  const { t } = useTranslation()
  const [resultCallId, setResultCallId] = useState<string | null>(null)
  const [resultText, setResultText] = useState('')
  const toolCalls = props.version.toolCalls ?? []
  const resultCall = toolCalls.find((call) => call.id === resultCallId)

  if (toolCalls.length === 0) {
    return null
  }

  const openResultDialog = (call: MessageToolCall) => {
    setResultCallId(call.id)
    setResultText('')
  }

  const closeResultDialog = () => {
    setResultCallId(null)
    setResultText('')
  }

  const submitResult = () => {
    if (!resultCall) return
    props.onProvideResult?.(props.message, resultCall.id, resultText)
    closeResultDialog()
  }

  const showContinue =
    props.isLastMessage === true &&
    getCurrentVersion(props.message) === props.version &&
    canContinueToolCalls(props.message)

  return (
    <div className='flex flex-col gap-3 pb-2'>
      {toolCalls.map((call) => {
        const executionKey = toolCallExecutionKey(
          props.message,
          props.version,
          call.id
        )
        const isExecuting =
          props.executingToolCallKeys?.has(executionKey) ?? false
        const isAutoFilled =
          props.autoFilledToolCallKeys?.has(executionKey) ?? false
        const state = isExecuting
          ? 'input-available'
          : TOOL_CALL_UI_STATES[call.status]
        return (
          <Tool
            defaultOpen={state === 'approval-requested' || isExecuting}
            key={call.id}
          >
            <ToolHeader
              state={state}
              title={call.name}
              type={`tool-${call.name}` as ToolUIPart['type']}
            />
            <ToolContent>
              <ToolInput input={parseToolCallArguments(call.arguments)} />
              {call.status === TOOL_CALL_STATUS.COMPLETED &&
                call.result !== undefined && (
                  <ToolOutput errorText={undefined} output={call.result} />
                )}
              {call.status === TOOL_CALL_STATUS.ERROR && (
                <ToolOutput
                  errorText={t(call.errorMessage ?? TOOL_CALL_FAILED_CONTENT)}
                  output={undefined}
                />
              )}
              {isExecuting && (
                <div
                  className='text-muted-foreground mx-4 mb-4 flex items-center gap-2 text-sm'
                  role='status'
                >
                  <Loader className='size-4' />
                  {t('Running the tool call automatically...')}
                </div>
              )}
              {!isExecuting && call.status !== TOOL_CALL_STATUS.ERROR && (
                <Confirmation
                  approval={{
                    approved: call.status !== TOOL_CALL_STATUS.DENIED,
                  }}
                  className='mx-4 mb-4'
                  state={state}
                >
                  <ConfirmationRequest>
                    <ConfirmationTitle>
                      {t('This tool call is waiting for a result.')}
                    </ConfirmationTitle>
                  </ConfirmationRequest>
                  <ConfirmationActions>
                    <ConfirmationAction
                      disabled={props.isGenerating}
                      onClick={() => props.onDeny?.(props.message, call.id)}
                      variant='outline'
                    >
                      {t('Deny')}
                    </ConfirmationAction>
                    <ConfirmationAction
                      disabled={props.isGenerating}
                      onClick={() => openResultDialog(call)}
                    >
                      {t('Provide result')}
                    </ConfirmationAction>
                  </ConfirmationActions>
                  <ConfirmationAccepted>
                    {isAutoFilled
                      ? t('Result auto-filled')
                      : t('Result provided')}
                  </ConfirmationAccepted>
                  <ConfirmationRejected>
                    {t('Tool call denied')}
                  </ConfirmationRejected>
                </Confirmation>
              )}
            </ToolContent>
          </Tool>
        )
      })}

      {showContinue && (
        <div className='flex justify-end'>
          <Button
            disabled={props.isGenerating}
            onClick={() => props.onContinue?.(props.message)}
            size='sm'
            type='button'
            variant='outline'
          >
            <Play aria-hidden='true' className='size-4' />
            {t('Continue generation')}
          </Button>
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) closeResultDialog()
        }}
        open={resultCall !== undefined}
      >
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>{t('Provide tool result')}</DialogTitle>
            <DialogDescription>
              {t(
                'The Playground does not run tools. Paste the result obtained elsewhere; it is sent back to the model as a tool message.'
              )}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t('Tool result')}
            maxLength={PLAYGROUND_TOOL_CALL_RESULT_MAX_CHARS}
            onChange={(event) => setResultText(event.target.value)}
            placeholder={t('Paste the tool result here')}
            rows={6}
            value={resultText}
          />
          <DialogFooter>
            <Button onClick={closeResultDialog} type='button' variant='outline'>
              {t('Cancel')}
            </Button>
            <Button
              disabled={!resultText.trim()}
              onClick={submitResult}
              type='button'
            >
              {t('Provide result')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
