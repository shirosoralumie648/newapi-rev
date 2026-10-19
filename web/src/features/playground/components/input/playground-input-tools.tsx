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
import { GlobeIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  PromptInputButton,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import type { KnowledgeBase } from '../../knowledge-api'
import { getSearchActionNotice } from '../../lib'
import type { PlaygroundContextPlan } from '../../lib'
import type {
  ModelOption,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../../types'
import { PlaygroundAssetPicker } from './playground-asset-picker'
import { PlaygroundAutoReadControl } from './playground-auto-read-control'
import { PlaygroundAutoTitleControl } from './playground-auto-title-control'
import { PlaygroundComparePanel } from './playground-compare-panel'
import {
  PlaygroundContextPanel,
  type PlaygroundKnowledgeDiagnostics,
} from './playground-context-panel'
import { PlaygroundDictationPanel } from './playground-dictation-panel'
import { PlaygroundParameterPanel } from './playground-parameter-panel'
import { PlaygroundSnippetPanel } from './playground-snippet-panel'
import { PlaygroundSystemPromptPanel } from './playground-system-prompt-panel'

type PlaygroundInputToolsProps = {
  config: PlaygroundConfig
  disabled?: boolean
  hasMessages?: boolean
  models: ModelOption[]
  /** Inserts a dictation transcript into the composer. */
  onDictateTranscript?: (text: string) => void
  /** Models of the next comparison; empty or single means an ordinary send. */
  compareModels: string[]
  onCompareModelsChange: (models: string[]) => void
  onClearMessages?: () => void
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onParameterEnabledChange: (
    key: keyof ParameterEnabled,
    value: boolean
  ) => void
  parameterEnabled: ParameterEnabled
  systemPrompt: string
  onSystemPromptChange: (value: string) => void
  /** Appends a prompt snippet to the composer draft. */
  onInsertText: (content: string) => void
  contextSettings: PlaygroundContextSettings
  contextPlan: PlaygroundContextPlan
  contextSummary: PlaygroundContextSummary | null
  isSummarizing?: boolean
  onContextSettingsChange: (settings: PlaygroundContextSettings) => void
  onRemoveContextSummary: () => void
  onSummarizeContext: () => void
  /** Knowledge bases the account may bind to the conversation. */
  knowledgeBases?: KnowledgeBase[]
  knowledgeBaseIds?: string[]
  onKnowledgeBaseIdsChange?: (knowledgeBaseIds: string[]) => void
  knowledgeDiagnostics?: PlaygroundKnowledgeDiagnostics | null
  knowledgeLoading?: boolean
  /** Effective auto read-aloud state of the active conversation. */
  autoReadEnabled: boolean
  /** Account default applied to conversations without an override. */
  autoReadDefaultEnabled: boolean
  /** Whether the active conversation carries an explicit choice. */
  autoReadHasOverride: boolean
  onAutoReadChange: (value: boolean) => void
  onAutoReadUseDefault: () => void
  onAutoReadDefaultChange: (value: boolean) => void
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

export function PlaygroundInputTools({
  config,
  disabled,
  hasMessages = false,
  models,
  onDictateTranscript,
  compareModels,
  onCompareModelsChange,
  onClearMessages,
  onConfigChange,
  onParameterEnabledChange,
  parameterEnabled,
  systemPrompt,
  onSystemPromptChange,
  onInsertText,
  contextSettings,
  contextPlan,
  contextSummary,
  isSummarizing,
  onContextSettingsChange,
  onRemoveContextSummary,
  onSummarizeContext,
  knowledgeBases,
  knowledgeBaseIds,
  onKnowledgeBaseIdsChange,
  knowledgeDiagnostics,
  knowledgeLoading,
  autoReadEnabled,
  autoReadDefaultEnabled,
  autoReadHasOverride,
  onAutoReadChange,
  onAutoReadUseDefault,
  onAutoReadDefaultChange,
  autoTitleEnabled,
  autoTitleDefaultEnabled,
  autoTitleHasOverride,
  onAutoTitleChange,
  onAutoTitleUseDefault,
  onAutoTitleDefaultChange,
}: PlaygroundInputToolsProps) {
  const { t } = useTranslation()
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)

  const handleSearchAction = () => {
    const notice = getSearchActionNotice()
    toast.info(t(notice.title))
  }

  const handleClearMessages = () => {
    onClearMessages?.()
    setClearConfirmOpen(false)
    toast.success(t('Conversation cleared'))
  }

  return (
    <>
      <PromptInputTools className='bg-background/70 border-border/60 rounded-lg border p-1 shadow-xs'>
        <PlaygroundAssetPicker
          disabled={disabled}
          onInsertText={onInsertText}
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <PromptInputButton
                aria-label={t('Search')}
                className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
                disabled={disabled}
                onClick={handleSearchAction}
                variant='ghost'
              >
                <GlobeIcon size={16} />
              </PromptInputButton>
            }
          />
          <TooltipContent>
            <p>{t('Search')}</p>
          </TooltipContent>
        </Tooltip>

        {onDictateTranscript ? (
          <PlaygroundDictationPanel
            disabled={disabled}
            group={config.group}
            models={models}
            onTranscript={onDictateTranscript}
          />
        ) : null}

        <PlaygroundAutoReadControl
          defaultEnabled={autoReadDefaultEnabled}
          disabled={disabled}
          enabled={autoReadEnabled}
          hasOverride={autoReadHasOverride}
          onDefaultChange={onAutoReadDefaultChange}
          onEnabledChange={onAutoReadChange}
          onUseDefault={onAutoReadUseDefault}
        />

        <PlaygroundAutoTitleControl
          defaultEnabled={autoTitleDefaultEnabled}
          disabled={disabled}
          enabled={autoTitleEnabled}
          hasOverride={autoTitleHasOverride}
          onDefaultChange={onAutoTitleDefaultChange}
          onEnabledChange={onAutoTitleChange}
          onUseDefault={onAutoTitleUseDefault}
        />

        <PlaygroundComparePanel
          compareModels={compareModels}
          disabled={disabled}
          models={models}
          onCompareModelsChange={onCompareModelsChange}
        />

        <PlaygroundParameterPanel
          config={config}
          disabled={disabled}
          onConfigChange={onConfigChange}
          onParameterEnabledChange={onParameterEnabledChange}
          parameterEnabled={parameterEnabled}
        />

        <PlaygroundSystemPromptPanel
          disabled={disabled}
          onSystemPromptChange={onSystemPromptChange}
          systemPrompt={systemPrompt}
        />

        <PlaygroundSnippetPanel
          disabled={disabled}
          onInsertSnippet={onInsertText}
        />

        <PlaygroundContextPanel
          currentModel={config.model}
          disabled={disabled}
          isSummarizing={isSummarizing}
          knowledgeBaseIds={knowledgeBaseIds}
          knowledgeBases={knowledgeBases}
          knowledgeDiagnostics={knowledgeDiagnostics}
          knowledgeLoading={knowledgeLoading}
          models={models}
          onKnowledgeBaseIdsChange={onKnowledgeBaseIdsChange}
          onRemoveSummary={onRemoveContextSummary}
          onSettingsChange={onContextSettingsChange}
          onSummarizeNow={onSummarizeContext}
          plan={contextPlan}
          settings={contextSettings}
          summary={contextSummary}
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <PromptInputButton
                aria-label={t('Clear chat history')}
                className='text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-medium'
                disabled={disabled || !hasMessages || !onClearMessages}
                onClick={() => setClearConfirmOpen(true)}
                variant='ghost'
              >
                <Trash2Icon size={16} />
              </PromptInputButton>
            }
          />
          <TooltipContent>
            <p>{t('Clear chat history')}</p>
          </TooltipContent>
        </Tooltip>
      </PromptInputTools>

      <ConfirmDialog
        destructive
        desc={t(
          'All playground messages saved in this browser will be removed. This cannot be undone.'
        )}
        confirmText={t('Clear')}
        handleConfirm={handleClearMessages}
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title={t('Clear chat history?')}
      />
    </>
  )
}
