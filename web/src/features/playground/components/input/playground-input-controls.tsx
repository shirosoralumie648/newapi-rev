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
import { SendIcon, SquareIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PromptInputButton,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { ModelGroupSelector } from '@/components/model-group-selector'
import { useIsMobile } from '@/hooks/use-mobile'

import {
  describeModelCapabilities,
  describeModelPrice,
  formatModelPriceLabel,
  getInputControlState,
  isChatModelOption,
} from '../../lib'
import type { GroupOption, ModelOption } from '../../types'

type PlaygroundInputControlsProps = {
  disabled?: boolean
  groups: GroupOption[]
  groupValue: string
  isGenerating?: boolean
  isModelLoading?: boolean
  models: ModelOption[]
  modelValue: string
  /** Controlled selector opened by an error action. */
  modelSelectorOpen?: boolean
  onModelSelectorOpenChange?: (open: boolean) => void
  onGroupChange: (value: string) => void
  onModelChange: (value: string) => void
  onStartNewSession?: (model: string) => void
  onStop?: () => void
  text: string
  tools: ReactNode
}

export function PlaygroundInputControls({
  disabled,
  groups,
  groupValue,
  isGenerating,
  isModelLoading = false,
  models,
  modelValue,
  modelSelectorOpen,
  onModelSelectorOpenChange,
  onGroupChange,
  onModelChange,
  onStartNewSession,
  onStop,
  text,
  tools,
}: PlaygroundInputControlsProps) {
  const { t } = useTranslation()
  const attachments = usePromptInputAttachments()
  const isMobile = useIsMobile()
  const groupRatio = groups.find((group) => group.value === groupValue)?.ratio
  // Prices and capability tags travel with the model options so the shared
  // selector stays display-only.
  const selectorModels = useMemo(
    () =>
      models.filter(isChatModelOption).map((model) => ({
        ...model,
        priceLabel: formatModelPriceLabel(
          describeModelPrice(model, groupRatio),
          t
        ),
        capabilityLabels: describeModelCapabilities(model.capabilities, t),
      })),
    [models, groupRatio, t]
  )
  const { canSubmit, isSelectorDisabled, shouldShowStop } =
    getInputControlState({
      disabled,
      groups,
      hasAttachments: attachments.files.length > 0,
      hasStopHandler: Boolean(onStop),
      isGenerating,
      isModelLoading,
      models: selectorModels,
      text,
    })

  const renderSelector = () => (
    <div className='min-w-0' data-tour='composer-model'>
      <ModelGroupSelector
        selectedModel={modelValue}
        models={selectorModels}
        onModelChange={onModelChange}
        selectedGroup={groupValue}
        groups={groups}
        onGroupChange={onGroupChange}
        onOpenChange={onModelSelectorOpenChange}
        onStartNewSession={onStartNewSession}
        open={modelSelectorOpen}
        disabled={isSelectorDisabled}
      />
    </div>
  )

  const renderSubmitButton = () =>
    shouldShowStop ? (
      <PromptInputButton
        className='border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/15 font-medium'
        onClick={onStop}
        variant='secondary'
      >
        <SquareIcon className='fill-current' size={16} />
        <span className='hidden sm:inline'>{t('Stop')}</span>
        <span className='sr-only sm:hidden'>{t('Stop')}</span>
      </PromptInputButton>
    ) : (
      <PromptInputButton
        className='bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground h-8 px-3 font-medium shadow-sm'
        disabled={!canSubmit}
        type='submit'
        variant='default'
      >
        <SendIcon size={16} />
        <span className='hidden sm:inline'>{t('Send')}</span>
        <span className='sr-only sm:hidden'>{t('Send')}</span>
      </PromptInputButton>
    )

  return (
    <div className='flex w-full flex-col gap-2.5 md:flex-row md:items-center md:justify-between'>
      <div className='flex min-w-0 items-center justify-end md:hidden'>
        {isMobile ? renderSelector() : null}
      </div>

      <div className='flex items-center justify-between gap-2 md:justify-start'>
        {tools}
        <div className='flex items-center gap-1.5 md:hidden'>
          {renderSubmitButton()}
        </div>
      </div>

      <div className='hidden min-w-0 items-center gap-2 md:flex'>
        {isMobile ? null : renderSelector()}
        {renderSubmitButton()}
      </div>
    </div>
  )
}
