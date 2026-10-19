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
import { Code2, GlobeIcon, Table2Icon, Trash2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'
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

import { DEFAULT_DEVELOPER_OPTIONS } from '../../constants'
import type { KnowledgeBase } from '../../knowledge-api'
import type { PlaygroundContextPlan } from '../../lib'
import { playgroundProtocolUnsupportedFields } from '../../lib/protocol/protocol-payload'
import { buildChatCompletionPayload } from '../../lib/streaming/payload-builder'
import type {
  ModelOption,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  PlaygroundDeveloperOptions,
} from '../../types'
import { PlaygroundAssetPicker } from './playground-asset-picker'
import { PlaygroundAutoReadControl } from './playground-auto-read-control'
import { PlaygroundAutoTitleControl } from './playground-auto-title-control'
import { PlaygroundComparePanel } from './playground-compare-panel'
import {
  PlaygroundContextPanel,
  type PlaygroundKnowledgeDiagnostics,
} from './playground-context-panel'
import { PlaygroundDeveloperPanel } from './playground-developer-panel'
import { PlaygroundDictationPanel } from './playground-dictation-panel'
import { PlaygroundParameterPanel } from './playground-parameter-panel'
import { PlaygroundProtocolSelect } from './playground-protocol-select'
import { PlaygroundSnippetPanel } from './playground-snippet-panel'
import { PlaygroundSystemPromptPanel } from './playground-system-prompt-panel'
import {
  PlaygroundToolExecutionControl,
  type PlaygroundToolExecutionMCPProps,
} from './playground-tool-execution-control'

type PlaygroundInputToolsProps = {
  config: PlaygroundConfig
  disabled?: boolean
  hasMessages?: boolean
  /** Whether the last send was captured and can be previewed. */
  hasCapturedRequest?: boolean
  /** Opens the request viewer of the last captured payload. */
  onOpenRequestViewer?: () => void
  models: ModelOption[]
  /** Inserts a dictation transcript into the composer. */
  onDictateTranscript?: (text: string) => void
  /** Models of the next comparison; empty or single means an ordinary send. */
  compareModels: string[]
  onCompareModelsChange: (models: string[]) => void
  /** Opens the batch compare-runs workbench. */
  onOpenCompareRuns?: () => void
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
  /** Request-side developer settings of the active conversation. */
  developerOptions?: PlaygroundDeveloperOptions
  /** Stores changed developer settings on the active conversation. */
  onDeveloperOptionsChange?: (options: PlaygroundDeveloperOptions) => void
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
  /** Whether the administrator configured web search for this deployment. */
  webSearchAvailable?: boolean
  /** Whether the next submitted turn also searches the web. */
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
  /** Whether the account enabled the automatic tool loop. */
  toolExecutionEnabled: boolean
  /** Automatic continuation round cap of the account. */
  toolExecutionMaxRounds: number
  onToolExecutionEnabledChange: (value: boolean) => void
  onToolExecutionMaxRoundsChange: (value: number) => void
  /** Account-level MCP switch and catalog; absent while the server has MCP off. */
  mcp?: PlaygroundToolExecutionMCPProps
}

export function PlaygroundInputTools({
  config,
  disabled,
  hasMessages = false,
  hasCapturedRequest = false,
  onOpenRequestViewer,
  models,
  onDictateTranscript,
  compareModels,
  onCompareModelsChange,
  onOpenCompareRuns,
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
  developerOptions = DEFAULT_DEVELOPER_OPTIONS,
  onDeveloperOptionsChange,
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
  webSearchAvailable = false,
  webSearchEnabled = false,
  onWebSearchChange,
  autoTitleEnabled,
  autoTitleDefaultEnabled,
  autoTitleHasOverride,
  onAutoTitleChange,
  onAutoTitleUseDefault,
  onAutoTitleDefaultChange,
  toolExecutionEnabled,
  toolExecutionMaxRounds,
  onToolExecutionEnabledChange,
  onToolExecutionMaxRoundsChange,
  mcp,
}: PlaygroundInputToolsProps) {
  const { t } = useTranslation()
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  // Probe the payload of the next send so the warning names exactly what the
  // selected protocol drops; a disabled parameter never appears because the
  // real builder is used instead of a static per-protocol list.
  const unsupportedFields = useMemo(
    () =>
      playgroundProtocolUnsupportedFields(
        buildChatCompletionPayload(
          [],
          config,
          parameterEnabled,
          '',
          undefined,
          '',
          null,
          developerOptions
        ),
        config.protocol
      ),
    [config, parameterEnabled, developerOptions]
  )

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

        <PlaygroundAutoTitleControl
          defaultEnabled={autoTitleDefaultEnabled}
          disabled={disabled}
          enabled={autoTitleEnabled}
          hasOverride={autoTitleHasOverride}
          onDefaultChange={onAutoTitleDefaultChange}
          onEnabledChange={onAutoTitleChange}
          onUseDefault={onAutoTitleUseDefault}
        />

        <PlaygroundToolExecutionControl
          disabled={disabled}
          enabled={toolExecutionEnabled}
          maxRounds={toolExecutionMaxRounds}
          mcp={mcp}
          onEnabledChange={onToolExecutionEnabledChange}
          onMaxRoundsChange={onToolExecutionMaxRoundsChange}
        />

        <PlaygroundComparePanel
          compareModels={compareModels}
          disabled={disabled}
          models={models}
          onCompareModelsChange={onCompareModelsChange}
        />

        {onOpenCompareRuns ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <PromptInputButton
                  aria-label={t('Compare runs')}
                  className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
                  disabled={disabled}
                  onClick={onOpenCompareRuns}
                  variant='ghost'
                >
                  <Table2Icon size={16} />
                </PromptInputButton>
              }
            />
            <TooltipContent>
              <p>{t('Run selected models against many prompts')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <PlaygroundProtocolSelect
          disabled={disabled}
          onChange={(protocol) => onConfigChange('protocol', protocol)}
          unsupportedFields={unsupportedFields}
          value={config.protocol}
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

        <PlaygroundDeveloperPanel
          disabled={disabled}
          onOptionsChange={(next) => onDeveloperOptionsChange?.(next)}
          options={developerOptions}
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <PromptInputButton
                aria-label={t('Request preview')}
                className='text-muted-foreground hover:text-foreground hover:bg-muted/70 font-medium'
                disabled={
                  disabled || !hasCapturedRequest || !onOpenRequestViewer
                }
                onClick={onOpenRequestViewer}
                variant='ghost'
              >
                <Code2 size={16} />
              </PromptInputButton>
            }
          />
          <TooltipContent>
            <p>{t('View the request payload of the last send')}</p>
          </TooltipContent>
        </Tooltip>

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
