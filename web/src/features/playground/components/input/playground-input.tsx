import type { FileUIPart } from 'ai'
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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputFooter,
  PromptInputTextarea,
  usePromptInputAttachments,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'

import {
  PLAYGROUND_ATTACHMENT_MAX_COUNT,
  PLAYGROUND_CHAT_ATTACHMENT_ACCEPT,
  PLAYGROUND_DOCUMENT_MAX_BYTES,
} from '../../constants'
import { usePlaygroundComposerMemory } from '../../hooks'
import type { PlaygroundContextPlan } from '../../lib'
import type {
  ModelOption,
  GroupOption,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../../types'
import { PlaygroundInputControls } from './playground-input-controls'
import { PlaygroundInputTools } from './playground-input-tools'

interface PlaygroundInputProps {
  config: PlaygroundConfig
  /** Active conversation the draft is stored under. */
  sessionId?: string | null
  onSubmit: (
    text: string,
    files: (FileUIPart & { id?: string })[]
  ) => Promise<void> | void
  onStop?: () => void
  disabled?: boolean
  isGenerating?: boolean
  models: ModelOption[]
  modelValue: string
  onModelChange: (value: string) => void
  isModelLoading?: boolean
  groups: GroupOption[]
  groupValue: string
  onGroupChange: (value: string) => void
  /** Models of the next comparison; fewer than two means an ordinary send. */
  compareModels: string[]
  onCompareModelsChange: (models: string[]) => void
  hasMessages?: boolean
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onClearMessages?: () => void
  onParameterEnabledChange: (
    key: keyof ParameterEnabled,
    value: boolean
  ) => void
  parameterEnabled: ParameterEnabled
  systemPrompt: string
  onSystemPromptChange: (value: string) => void
  contextSettings: PlaygroundContextSettings
  contextPlan: PlaygroundContextPlan
  contextSummary: PlaygroundContextSummary | null
  isSummarizing?: boolean
  onContextSettingsChange: (settings: PlaygroundContextSettings) => void
  onRemoveContextSummary: () => void
  onSummarizeContext: () => void
  /** Effective auto read-aloud state of the active conversation. */
  autoReadEnabled: boolean
  /** Account default applied to conversations without an override. */
  autoReadDefaultEnabled: boolean
  /** Whether the active conversation carries an explicit choice. */
  autoReadHasOverride: boolean
  onAutoReadChange: (value: boolean) => void
  onAutoReadUseDefault: () => void
  onAutoReadDefaultChange: (value: boolean) => void
  /**
   * Files the workspace wants added to the composer (for example "send to
   * chat" from the asset library). Each array is consumed once and validated
   * through the normal attachment path.
   */
  pendingFiles?: File[]
  onPendingFilesConsumed?: () => void
  /** Text appended to the composer exactly once, e.g. an artifact body. */
  pendingText?: string | null
  onPendingTextConsumed?: () => void
}

export function PlaygroundInput({
  config,
  sessionId,
  onSubmit,
  onStop,
  disabled,
  isGenerating,
  models,
  modelValue,
  onModelChange,
  isModelLoading = false,
  groups,
  groupValue,
  onGroupChange,
  compareModels,
  onCompareModelsChange,
  hasMessages = false,
  onConfigChange,
  onClearMessages,
  onParameterEnabledChange,
  parameterEnabled,
  systemPrompt,
  onSystemPromptChange,
  contextSettings,
  contextPlan,
  contextSummary,
  isSummarizing,
  onContextSettingsChange,
  onRemoveContextSummary,
  onSummarizeContext,
  autoReadEnabled,
  autoReadDefaultEnabled,
  autoReadHasOverride,
  onAutoReadChange,
  onAutoReadUseDefault,
  onAutoReadDefaultChange,
  pendingFiles,
  onPendingFilesConsumed,
  pendingText,
  onPendingTextConsumed,
}: PlaygroundInputProps) {
  const { t } = useTranslation()
  const { text, updateText, appendText, handleKeyDown, rememberSubmittedText } =
    usePlaygroundComposerMemory(sessionId)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (pendingText == null) return
    appendText(pendingText)
    onPendingTextConsumed?.()
  }, [appendText, onPendingTextConsumed, pendingText])

  const handleSubmit = async (message: PromptInputMessage) => {
    if (disabled || submitting) return
    const files = message.files ?? []
    if (!message.text?.trim() && files.length === 0) return

    setSubmitting(true)
    try {
      // Clear only after the send (including any upload) succeeds so a failed
      // message stays recoverable in the input.
      await onSubmit(message.text ?? '', files)
      rememberSubmittedText(message.text ?? '')
      updateText('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className='grid shrink-0 gap-4 px-1 md:pb-4'>
      <PromptInput
        accept={PLAYGROUND_CHAT_ATTACHMENT_ACCEPT}
        className='relative'
        groupClassName='bg-background/95 dark:bg-background/80 border-border/70 shadow-[0_18px_60px_-32px_rgba(0,0,0,0.65)] ring-1 ring-foreground/5 rounded-xl overflow-hidden transition-all duration-200 focus-within:border-primary/45 focus-within:ring-primary/15 focus-within:shadow-[0_22px_70px_-34px_rgba(0,0,0,0.75)]'
        maxFiles={PLAYGROUND_ATTACHMENT_MAX_COUNT}
        maxFileSize={PLAYGROUND_DOCUMENT_MAX_BYTES}
        multiple
        onError={(error) => toast.error(error.message)}
        onSubmit={handleSubmit}
      >
        {pendingFiles && pendingFiles.length > 0 ? (
          <PlaygroundPendingFiles
            files={pendingFiles}
            onConsumed={onPendingFilesConsumed}
          />
        ) : null}
        <div className='flex flex-wrap gap-1.5 px-3 pt-3 empty:hidden'>
          <PromptInputAttachments>
            {(attachment) => <PromptInputAttachment data={attachment} />}
          </PromptInputAttachments>
        </div>

        <PromptInputTextarea
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
          className='min-h-20 px-5 pt-4 pb-3 leading-7 md:min-h-24 md:text-base'
          disabled={disabled}
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('Ask anything')}
          value={text}
        />

        <PromptInputFooter className='border-border/60 bg-muted/20 dark:bg-muted/10 border-t px-3 py-2.5 backdrop-blur'>
          <PlaygroundInputControls
            disabled={disabled}
            groups={groups}
            groupValue={groupValue}
            isGenerating={isGenerating}
            isModelLoading={isModelLoading}
            models={models}
            modelValue={modelValue}
            onGroupChange={onGroupChange}
            onModelChange={onModelChange}
            onStop={onStop}
            text={text}
            tools={
              <PlaygroundInputTools
                autoReadDefaultEnabled={autoReadDefaultEnabled}
                autoReadEnabled={autoReadEnabled}
                autoReadHasOverride={autoReadHasOverride}
                config={config}
                contextPlan={contextPlan}
                contextSettings={contextSettings}
                contextSummary={contextSummary}
                disabled={disabled}
                hasMessages={hasMessages}
                isSummarizing={isSummarizing}
                models={models}
                onAutoReadChange={onAutoReadChange}
                onAutoReadDefaultChange={onAutoReadDefaultChange}
                onAutoReadUseDefault={onAutoReadUseDefault}
                compareModels={compareModels}
                onCompareModelsChange={onCompareModelsChange}
                onClearMessages={onClearMessages}
                onConfigChange={onConfigChange}
                onContextSettingsChange={onContextSettingsChange}
                onDictateTranscript={appendText}
                onInsertText={appendText}
                onParameterEnabledChange={onParameterEnabledChange}
                onRemoveContextSummary={onRemoveContextSummary}
                onSummarizeContext={onSummarizeContext}
                onSystemPromptChange={onSystemPromptChange}
                parameterEnabled={parameterEnabled}
                systemPrompt={systemPrompt}
              />
            }
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

/**
 * Hands a batch of externally supplied files to the composer exactly once.
 * It must live inside PromptInput so it joins the same local attachments
 * context as the file picker, and the batch identity guard keeps re-renders
 * from adding the same files again.
 */
function PlaygroundPendingFiles(props: {
  files: File[]
  onConsumed?: () => void
}) {
  const attachments = usePromptInputAttachments()
  const consumedRef = useRef<File[] | null>(null)

  useEffect(() => {
    if (props.files.length === 0 || consumedRef.current === props.files) return
    consumedRef.current = props.files
    attachments.add(props.files)
    props.onConsumed?.()
  }, [attachments, props.files, props.onConsumed])

  return null
}
