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
import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import {
  PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX,
  PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX,
} from '../../constants'
import type { KnowledgeBase } from '../../knowledge-api'
import type { PlaygroundContextPlan } from '../../lib'
import type {
  KnowledgeStaleDocument,
  ModelOption,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../../types'

export type PlaygroundKnowledgeDiagnostics = {
  staleDocuments: KnowledgeStaleDocument[]
  resultCount: number
  retrievedAt: number
}

type PlaygroundContextPanelProps = {
  settings: PlaygroundContextSettings
  summary: PlaygroundContextSummary | null
  /** The plan of the next send: size, dropped messages and node usage. */
  plan: PlaygroundContextPlan
  models: ModelOption[]
  currentModel: string
  disabled?: boolean
  isSummarizing?: boolean
  onSettingsChange: (settings: PlaygroundContextSettings) => void
  onRemoveSummary: () => void
  onSummarizeNow: () => void
  /** Knowledge bases the account may bind to the conversation. */
  knowledgeBases?: KnowledgeBase[]
  /** Bases bound to the active conversation; at most three. */
  knowledgeBaseIds?: string[]
  onKnowledgeBaseIdsChange?: (knowledgeBaseIds: string[]) => void
  /** Last retrieval result: stale documents the merge skipped. */
  knowledgeDiagnostics?: PlaygroundKnowledgeDiagnostics | null
  knowledgeLoading?: boolean
}

type PlaygroundContextContentProps = PlaygroundContextPanelProps & {
  open: boolean
  compact?: boolean
}

// Numeric inputs store 0 as the empty string so the field can be cleared; any
// unparsable or negative draft falls back to "no limit".
function parseBoundedInput(value: string, max: number): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(parsed, max)
}

function PlaygroundContextContent(props: PlaygroundContextContentProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const sentMessageCount =
    props.plan.includedMessages.length + (props.plan.summaryUsed ? 1 : 0)
  const droppedTokens = props.plan.droppedTokens
  const modelItems = [
    { value: '', label: t('Same as conversation model') },
    ...props.models
      .filter((model) => model.value !== '')
      .map((model) => ({ value: model.value, label: model.label })),
  ]
  if (
    props.settings.summaryModel &&
    !modelItems.some((item) => item.value === props.settings.summaryModel)
  ) {
    modelItems.push({
      value: props.settings.summaryModel,
      label: props.settings.summaryModel,
    })
  }

  const updateSettings = (patch: Partial<PlaygroundContextSettings>) => {
    props.onSettingsChange({ ...props.settings, ...patch })
  }

  const boundKnowledgeBaseIds = props.knowledgeBaseIds ?? []
  const staleDocuments = props.knowledgeDiagnostics?.staleDocuments ?? []
  const toggleKnowledgeBase = (knowledgeBaseId: string, checked: boolean) => {
    const next = checked
      ? [...boundKnowledgeBaseIds, knowledgeBaseId]
      : boundKnowledgeBaseIds.filter((id) => id !== knowledgeBaseId)
    props.onKnowledgeBaseIdsChange?.(next)
  }

  return (
    <div className='grid gap-3 p-1'>
      <div className='space-y-1 px-1'>
        <p className='text-muted-foreground text-xs leading-4'>
          {t(
            'Context to send: {{messages}} messages · ~{{tokens}} tokens (estimated)',
            {
              messages: formatNumber(sentMessageCount, locale),
              tokens: formatNumber(props.plan.estimatedTokens, locale),
            }
          )}
        </p>

        <div className='border-border/60 grid gap-2 border-t pt-3'>
          <p className='px-1 text-xs font-semibold'>{t('Knowledge bases')}</p>
          {props.knowledgeLoading ? (
            <p className='text-muted-foreground px-1 text-xs'>
              {t('Loading knowledge bases...')}
            </p>
          ) : (props.knowledgeBases ?? []).length === 0 ? (
            <p className='text-muted-foreground px-1 text-xs'>
              {t('No knowledge bases yet')}
            </p>
          ) : (
            <div className='grid gap-1'>
              {(props.knowledgeBases ?? []).map((knowledgeBase) => {
                const checked = boundKnowledgeBaseIds.includes(knowledgeBase.id)
                return (
                  <label
                    className='hover:bg-muted/50 flex items-start gap-2 rounded-md px-1 py-1.5'
                    key={knowledgeBase.id}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={
                        props.disabled ||
                        (!checked && boundKnowledgeBaseIds.length >= 3)
                      }
                      onCheckedChange={(value) =>
                        toggleKnowledgeBase(knowledgeBase.id, value === true)
                      }
                    />
                    <span className='grid gap-0.5 text-xs leading-4'>
                      <span className='font-medium'>{knowledgeBase.name}</span>
                      <span className='text-muted-foreground'>
                        {knowledgeBase.embeddingModel}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
          <p className='text-muted-foreground px-1 text-xs'>
            {t('Up to three knowledge bases are searched on every send.')}
          </p>
          {staleDocuments.length > 0 && (
            <p
              className='text-destructive px-1 text-xs leading-4'
              role='status'
            >
              {t(
                '{{count}} knowledge documents need rebuilding before they can be cited: {{files}}',
                {
                  count: staleDocuments.length,
                  files: staleDocuments
                    .map((document) => document.filename)
                    .join(', '),
                }
              )}
            </p>
          )}
        </div>

        {props.plan.droppedMessages.length > 0 && (
          <p
            role='status'
            className='text-xs leading-4 text-amber-600 dark:text-amber-400'
          >
            {props.settings.autoSummarize
              ? t(
                  'The next send summarizes {{messages}} older messages (~{{tokens}} tokens).',
                  {
                    messages: formatNumber(
                      props.plan.droppedMessages.length,
                      locale
                    ),
                    tokens: formatNumber(droppedTokens, locale),
                  }
                )
              : t(
                  '{{messages}} older messages are left out of the next request (~{{tokens}} tokens).',
                  {
                    messages: formatNumber(
                      props.plan.droppedMessages.length,
                      locale
                    ),
                    tokens: formatNumber(droppedTokens, locale),
                  }
                )}
          </p>
        )}
        {props.plan.omittedImages > 0 && (
          <p
            role='status'
            className='text-xs leading-4 text-amber-600 dark:text-amber-400'
          >
            {t(
              '{{images}} images from earlier messages are left out of the next request.',
              {
                images: formatNumber(props.plan.omittedImages, locale),
              }
            )}
          </p>
        )}
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='playground-context-history-limit'>
          {t('History message limit')}
        </Label>
        <Input
          disabled={props.disabled}
          id='playground-context-history-limit'
          inputMode='numeric'
          max={PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX}
          min={0}
          onChange={(event) =>
            updateSettings({
              historyLimit: parseBoundedInput(
                event.target.value,
                PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX
              ),
            })
          }
          placeholder='0'
          type='number'
          value={
            props.settings.historyLimit === 0 ? '' : props.settings.historyLimit
          }
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='playground-context-token-budget'>
          {t('Token budget')}
        </Label>
        <Input
          disabled={props.disabled}
          id='playground-context-token-budget'
          inputMode='numeric'
          max={PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX}
          min={0}
          onChange={(event) =>
            updateSettings({
              tokenBudget: parseBoundedInput(
                event.target.value,
                PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX
              ),
            })
          }
          placeholder='0'
          type='number'
          value={
            props.settings.tokenBudget === 0 ? '' : props.settings.tokenBudget
          }
        />
      </div>
      <p className='text-muted-foreground px-1 text-xs leading-4'>
        {t(
          '0 means no limit. Older messages stay in this conversation but are not sent to the model.'
        )}
      </p>

      <div className='flex items-start justify-between gap-3 px-1'>
        <div className='grid gap-0.5'>
          <Label htmlFor='playground-context-auto-summarize'>
            {t('Summarize automatically')}
          </Label>
          <p className='text-muted-foreground text-xs leading-4'>
            {t(
              'When the history exceeds a limit, the oldest messages are summarized before sending. The summary request is billed like any other model call.'
            )}
          </p>
        </div>
        <Switch
          checked={props.settings.autoSummarize}
          disabled={props.disabled}
          id='playground-context-auto-summarize'
          onCheckedChange={(checked) =>
            updateSettings({ autoSummarize: checked })
          }
        />
      </div>

      <div className='grid gap-1.5'>
        <Label htmlFor='playground-context-summary-model'>
          {t('Summary model')}
        </Label>
        <Select
          items={modelItems}
          onValueChange={(value) => {
            if (typeof value !== 'string') return
            updateSettings({ summaryModel: value })
          }}
          value={props.settings.summaryModel}
        >
          <SelectTrigger
            disabled={props.disabled}
            id='playground-context-summary-model'
            size='sm'
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {modelItems.map((item) => (
                <SelectItem
                  key={item.value || 'conversation-model'}
                  value={item.value}
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className='border-border/60 grid gap-2 border-t pt-3'>
        <p className='px-1 text-xs font-semibold'>{t('Context summary')}</p>
        {props.summary ? (
          <div className='border-border/60 rounded-lg border p-3'>
            <div className='flex items-start justify-between gap-2'>
              <div className='min-w-0'>
                <p className='text-sm font-medium'>
                  {t('Compressed {{messages}} earlier messages', {
                    messages: formatNumber(props.summary.messageCount, locale),
                  })}
                </p>
                <p className='text-muted-foreground text-xs'>
                  {t('Generated with {{model}}', {
                    model: props.summary.model || props.currentModel,
                  })}
                </p>
                {!props.plan.summaryUsed && (
                  <p className='text-destructive text-xs'>
                    {t(
                      'The context summary no longer matches this conversation.'
                    )}
                  </p>
                )}
              </div>
              <Button
                disabled={props.disabled || props.isSummarizing}
                onClick={props.onRemoveSummary}
                size='sm'
                type='button'
                variant='outline'
              >
                {t('Remove summary')}
              </Button>
            </div>
            <Collapsible onOpenChange={setSummaryOpen} open={summaryOpen}>
              <CollapsibleTrigger
                render={
                  <Button
                    className='mt-2 h-7 px-2 text-xs'
                    size='sm'
                    type='button'
                    variant='ghost'
                  />
                }
              >
                {summaryOpen ? t('Hide summary') : t('Show summary')}
              </CollapsibleTrigger>
              <CollapsibleContent className='mt-2'>
                <p className='bg-muted/40 max-h-40 overflow-y-auto rounded-md p-2 text-xs break-words whitespace-pre-wrap'>
                  {props.summary.content}
                </p>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : (
          <p className='text-muted-foreground px-1 text-xs'>
            {t('No context summary yet.')}
          </p>
        )}
        <div className='flex justify-end'>
          <Button
            disabled={
              props.disabled || props.isSummarizing || !props.plan.needsSummary
            }
            onClick={props.onSummarizeNow}
            size='sm'
            type='button'
            variant='outline'
          >
            {props.isSummarizing
              ? t('Summarizing conversation...')
              : t('Summarize now')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Context management of the active conversation: the size of the next send,
 * the history or token limits, the optional automatic summarization and the
 * persisted compression node with its expand and undo actions.
 */
export function PlaygroundContextPanel(props: PlaygroundContextPanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const isActive =
    props.settings.historyLimit > 0 ||
    props.settings.tokenBudget > 0 ||
    props.settings.autoSummarize ||
    props.summary !== null ||
    (props.knowledgeBaseIds?.length ?? 0) > 0

  const trigger = (
    <PromptInputButton
      aria-label={t('Context management')}
      aria-pressed={isActive}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 relative font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <Gauge size={16} />
      {isActive && (
        <span
          aria-hidden='true'
          className='bg-primary absolute -top-1 -right-1 size-2 rounded-full'
        />
      )}
    </PromptInputButton>
  )

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpen} open={open}>
        <Tooltip>
          <TooltipTrigger render={<SheetTrigger render={trigger} />} />
          <TooltipContent>
            <p>{t('Context management')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Context management')}</SheetTitle>
          </SheetHeader>
          <div className='overflow-y-auto'>
            <PlaygroundContextContent {...props} compact open={open} />
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />} />
        <TooltipContent>
          <p>{t('Context management')}</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='max-h-[70vh] w-[26rem] max-w-[calc(100vw-2rem)] gap-2 overflow-y-auto p-3'
        collisionPadding={8}
        side='top'
        sideOffset={8}
      >
        <div className='space-y-1 px-1'>
          <div className='text-sm font-semibold'>{t('Context management')}</div>
        </div>
        <PlaygroundContextContent {...props} open={open} />
      </PopoverContent>
    </Popover>
  )
}
