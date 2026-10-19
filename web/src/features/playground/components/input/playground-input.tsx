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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputFooter,
  PromptInputTextarea,
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
  webSearchAvailable?: boolean
  webSearchEnabled?: boolean
  onWebSearchChange?: (value: boolean) => void
  /** Effective automatic naming state of the active conversation. */
  autoTitleEnabled: boolean
  /** Account default applied to conversations without an override. */
  autoTitleDefaultEnabled: boolean
  /** Whether the active conversation carries an explicit naming choice. */
  autoTitleHasOverride: boolean
  onAutoTitleChange: (value: boolean) => void
  onAutoTitleUseDefault: () => void
  onAutoTitleDefaultChange: (value: boolean) => void
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
  webSearchAvailable = false,
  webSearchEnabled = false,
  onWebSearchChange,
  autoTitleEnabled,
  autoTitleDefaultEnabled,
  autoTitleHasOverride,
  onAutoTitleChange,
  onAutoTitleUseDefault,
  onAutoTitleDefaultChange,
}: PlaygroundInputProps) {
  const { t } = useTranslation()
  const { text, updateText, appendText, handleKeyDown, rememberSubmittedText } =
    usePlaygroundComposerMemory(sessionId)
  const [submitting, setSubmitting] = useState(false)

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
                autoTitleDefaultEnabled={autoTitleDefaultEnabled}
                autoTitleEnabled={autoTitleEnabled}
                autoTitleHasOverride={autoTitleHasOverride}
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
                onAutoTitleChange={onAutoTitleChange}
                onAutoTitleDefaultChange={onAutoTitleDefaultChange}
                onAutoTitleUseDefault={onAutoTitleUseDefault}
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
                onWebSearchChange={onWebSearchChange}
                parameterEnabled={parameterEnabled}
                systemPrompt={systemPrompt}
                webSearchAvailable={webSearchAvailable}
                webSearchEnabled={webSearchEnabled}
              />
            }
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
