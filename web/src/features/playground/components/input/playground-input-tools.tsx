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
import { PlaygroundComparePanel } from './playground-compare-panel'
import { PlaygroundContextPanel } from './playground-context-panel'
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
  /** Effective auto read-aloud state of the active conversation. */
  autoReadEnabled: boolean
  /** Account default applied to conversations without an override. */
  autoReadDefaultEnabled: boolean
  /** Whether the active conversation carries an explicit choice. */
  autoReadHasOverride: boolean
  onAutoReadChange: (value: boolean) => void
  onAutoReadUseDefault: () => void
  onAutoReadDefaultChange: (value: boolean) => void
  /** Whether the administrator configured web search for this deployment. */
  webSearchAvailable?: boolean
  /** Whether the next submitted turn also searches the web. */
  webSearchEnabled?: boolean
  onWebSearchChange?: (value: boolean) => void
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
  autoReadEnabled,
  autoReadDefaultEnabled,
  autoReadHasOverride,
  onAutoReadChange,
  onAutoReadUseDefault,
  onAutoReadDefaultChange,
  webSearchAvailable = false,
  webSearchEnabled = false,
  onWebSearchChange,
}: PlaygroundInputToolsProps) {
  const { t } = useTranslation()
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)

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

        {webSearchAvailable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <PromptInputButton
                  aria-label={t('Search this turn')}
                  aria-pressed={webSearchEnabled}
                  className={
                    webSearchEnabled
                      ? 'bg-primary/10 text-primary hover:bg-primary/15 font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
                  }
                  disabled={disabled || !onWebSearchChange}
                  onClick={() => onWebSearchChange?.(!webSearchEnabled)}
                  variant='ghost'
                >
                  <GlobeIcon size={16} />
                </PromptInputButton>
              }
            />
            <TooltipContent>
              <p>
                {webSearchEnabled
                  ? t('Web search is on for this turn')
                  : t('Search the web with this turn')}
              </p>
            </TooltipContent>
          </Tooltip>
        ) : null}

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
          models={models}
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
