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
import { Braces, Plus, Trash2Icon } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

import {
  PLAYGROUND_DEVELOPER_ERRORS,
  PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH,
  PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT,
} from '../../constants'
import {
  developerOptionsActive,
  parseJsonSchemaText,
  validateDeveloperOptions,
} from '../../lib/developer/developer-options'
import type {
  ChatCompletionTool,
  PlaygroundDeveloperOptions,
  PlaygroundDeveloperResponseFormat,
  PlaygroundDeveloperToolChoice,
} from '../../types'

type PlaygroundDeveloperPanelProps = {
  options: PlaygroundDeveloperOptions
  disabled?: boolean
  onOptionsChange: (options: PlaygroundDeveloperOptions) => void
}

type PlaygroundDeveloperContentProps = PlaygroundDeveloperPanelProps & {
  open: boolean
  compact?: boolean
}

/**
 * One tool row while it is edited. The parameter schema is kept as text so a
 * half-typed JSON object never reaches the conversation state; only a save of
 * valid text parses it.
 */
type DeveloperToolDraft = {
  /** Stable row identity; the text of a row never changes its key. */
  id: string
  name: string
  description: string
  parametersText: string
  strict: boolean
}

type DeveloperDraft = {
  enabled: boolean
  tools: DeveloperToolDraft[]
  toolChoice: PlaygroundDeveloperToolChoice
  responseFormatType: PlaygroundDeveloperResponseFormat['type']
  schemaName: string
  schemaDescription: string
  schemaText: string
  schemaStrict: boolean
}

const TOOL_CHOICE_ITEMS: {
  value: PlaygroundDeveloperToolChoice
  label: string
}[] = [
  { value: '', label: 'Provider default' },
  { value: 'auto', label: 'Automatic' },
  { value: 'none', label: 'Never call a tool' },
  { value: 'required', label: 'Must call a tool' },
]

const RESPONSE_FORMAT_ITEMS: {
  value: PlaygroundDeveloperResponseFormat['type']
  label: string
}[] = [
  { value: 'text', label: 'Text' },
  { value: 'json_object', label: 'JSON object' },
  { value: 'json_schema', label: 'JSON Schema' },
]

function toDraft(options: PlaygroundDeveloperOptions): DeveloperDraft {
  const jsonSchema = options.responseFormat.jsonSchema
  return {
    enabled: options.enabled,
    tools: options.tools.map((tool) => ({
      id: nanoid(),
      name: tool.function.name,
      description: tool.function.description ?? '',
      parametersText: tool.function.parameters
        ? `${JSON.stringify(tool.function.parameters, null, 2)}\n`
        : '',
      strict: tool.function.strict === true,
    })),
    toolChoice: options.toolChoice,
    responseFormatType: options.responseFormat.type,
    schemaName: jsonSchema?.name ?? '',
    schemaDescription: jsonSchema?.description ?? '',
    schemaText: jsonSchema
      ? `${JSON.stringify(jsonSchema.schema, null, 2)}\n`
      : '',
    schemaStrict: jsonSchema?.strict === true,
  }
}

/**
 * The settings a save of this draft would store, or the i18n key of the first
 * problem that blocks the save. An unnamed tool row is a row in progress and is
 * dropped instead of blocking the save; everything else must be valid because
 * the server validates the same contract.
 */
function fromDraft(draft: DeveloperDraft): {
  options: PlaygroundDeveloperOptions | null
  error: string | null
} {
  const tools: ChatCompletionTool[] = []
  for (const tool of draft.tools) {
    const name = tool.name.trim()
    if (!name) continue
    const definition: ChatCompletionTool = {
      type: 'function',
      function: { name },
    }
    const description = tool.description.trim()
    if (description) definition.function.description = description
    const parametersText = tool.parametersText.trim()
    if (parametersText) {
      const parsed = parseJsonSchemaText(parametersText)
      if ('error' in parsed) return { options: null, error: parsed.error }
      definition.function.parameters = parsed.value
    }
    if (tool.strict) definition.function.strict = true
    tools.push(definition)
  }

  let responseFormat: PlaygroundDeveloperResponseFormat = { type: 'text' }
  if (draft.responseFormatType === 'json_object') {
    responseFormat = { type: 'json_object' }
  } else if (draft.responseFormatType === 'json_schema') {
    const name = draft.schemaName.trim()
    if (!name) {
      return {
        options: null,
        error: PLAYGROUND_DEVELOPER_ERRORS.RESPONSE_NAME_REQUIRED,
      }
    }
    const parsed = parseJsonSchemaText(draft.schemaText.trim())
    if ('error' in parsed) return { options: null, error: parsed.error }
    const jsonSchema: NonNullable<
      PlaygroundDeveloperResponseFormat['jsonSchema']
    > = { name, schema: parsed.value }
    const description = draft.schemaDescription.trim()
    if (description) jsonSchema.description = description
    if (draft.schemaStrict) jsonSchema.strict = true
    responseFormat = { type: 'json_schema', jsonSchema }
  }

  const options: PlaygroundDeveloperOptions = {
    enabled: draft.enabled,
    tools,
    // A choice without a tool describes nothing to call, so it is dropped.
    toolChoice: tools.length > 0 ? draft.toolChoice : '',
    responseFormat,
  }
  const problem = validateDeveloperOptions(options)
  if (problem) return { options: null, error: problem }
  return { options, error: null }
}

/**
 * Translation parameters of one editor error. Only the two bounded errors
 * interpolate a limit; every other key renders without parameters.
 */
function developerErrorParams(
  error: string
): Record<string, number> | undefined {
  if (error === PLAYGROUND_DEVELOPER_ERRORS.NAME_TOO_LONG) {
    return { count: PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH }
  }
  if (error === PLAYGROUND_DEVELOPER_ERRORS.TOO_MANY_TOOLS) {
    return { count: PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT }
  }
  return undefined
}

function PlaygroundDeveloperContent(props: PlaygroundDeveloperContentProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<DeveloperDraft>(() =>
    toDraft(props.options)
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (props.open) {
      setDraft(toDraft(props.options))
      setError(null)
    }
  }, [props.open, props.options])

  const updateTool = (id: string, patch: Partial<DeveloperToolDraft>) => {
    setDraft((current) => ({
      ...current,
      tools: current.tools.map((tool) =>
        tool.id === id ? { ...tool, ...patch } : tool
      ),
    }))
  }

  const addTool = () => {
    setDraft((current) => {
      if (current.tools.length >= PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT) {
        return current
      }
      return {
        ...current,
        tools: [
          ...current.tools,
          {
            id: nanoid(),
            name: '',
            description: '',
            parametersText: '',
            strict: false,
          },
        ],
      }
    })
  }

  const removeTool = (id: string) => {
    setDraft((current) => ({
      ...current,
      tools: current.tools.filter((tool) => tool.id !== id),
    }))
  }

  const save = () => {
    const result = fromDraft(draft)
    if (!result.options) {
      setError(result.error)
      return
    }
    setError(null)
    props.onOptionsChange(result.options)
    toast.success(t('Developer settings saved'))
  }

  const toolChoiceItems = TOOL_CHOICE_ITEMS.map((item) => ({
    value: item.value,
    label: t(item.label),
  }))
  const responseFormatItems = RESPONSE_FORMAT_ITEMS.map((item) => ({
    value: item.value,
    label: t(item.label),
  }))

  return (
    <div className='grid gap-3 p-1'>
      <div className='flex items-start justify-between gap-3 px-1'>
        <div className='grid gap-0.5'>
          <Label htmlFor='playground-developer-enabled'>
            {t('Enable developer settings')}
          </Label>
          <p className='text-muted-foreground text-xs leading-4'>
            {t(
              'While enabled, every request of this conversation carries the tool definitions and the response format below.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t('Enable developer settings')}
          checked={draft.enabled}
          disabled={props.disabled}
          id='playground-developer-enabled'
          onCheckedChange={(checked) =>
            setDraft((current) => ({ ...current, enabled: checked }))
          }
        />
      </div>

      <div className='border-border/60 grid gap-2 border-t pt-3'>
        <div className='flex items-center justify-between gap-2 px-1'>
          <p className='text-xs font-semibold'>{t('Tools')}</p>
          <Button
            disabled={
              props.disabled ||
              draft.tools.length >= PLAYGROUND_DEVELOPER_TOOL_MAX_COUNT
            }
            onClick={addTool}
            size='sm'
            type='button'
            variant='outline'
          >
            <Plus size={14} />
            {t('Add tool')}
          </Button>
        </div>
        {draft.tools.length === 0 ? (
          <p className='text-muted-foreground px-1 text-xs leading-4'>
            {t(
              'No tools defined. The Playground describes tools for the model but never runs them; a requested call is answered manually.'
            )}
          </p>
        ) : (
          draft.tools.map((tool, index) => (
            <div
              className='border-border/60 grid gap-2 rounded-lg border p-2'
              key={tool.id}
            >
              <div className='flex items-center justify-between gap-2'>
                <p className='text-xs font-semibold'>
                  {t('Tool {{index}}', { index: index + 1 })}
                </p>
                <Button
                  aria-label={t('Remove tool')}
                  disabled={props.disabled}
                  onClick={() => removeTool(tool.id)}
                  size='sm'
                  type='button'
                  variant='ghost'
                >
                  <Trash2Icon size={14} />
                </Button>
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor={`playground-developer-tool-name-${tool.id}`}>
                  {t('Name')}
                </Label>
                <Input
                  disabled={props.disabled}
                  id={`playground-developer-tool-name-${tool.id}`}
                  maxLength={PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH}
                  onChange={(event) =>
                    updateTool(tool.id, { name: event.target.value })
                  }
                  placeholder='search_orders'
                  value={tool.name}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label
                  htmlFor={`playground-developer-tool-description-${tool.id}`}
                >
                  {t('Description')}
                </Label>
                <Input
                  disabled={props.disabled}
                  id={`playground-developer-tool-description-${tool.id}`}
                  onChange={(event) =>
                    updateTool(tool.id, { description: event.target.value })
                  }
                  placeholder={t('What the tool does, for the model.')}
                  value={tool.description}
                />
              </div>
              <div className='grid gap-1.5'>
                <Label
                  htmlFor={`playground-developer-tool-parameters-${tool.id}`}
                >
                  {t('Parameter schema (JSON)')}
                </Label>
                <Textarea
                  className='max-h-40 min-h-20 font-mono text-xs'
                  disabled={props.disabled}
                  id={`playground-developer-tool-parameters-${tool.id}`}
                  onChange={(event) =>
                    updateTool(tool.id, { parametersText: event.target.value })
                  }
                  placeholder={t('Leave blank for a tool without arguments.')}
                  value={tool.parametersText}
                />
              </div>
              <div className='flex items-center justify-between gap-3 px-1'>
                <p className='text-muted-foreground text-xs leading-4'>
                  {t('Reject arguments outside the schema when supported.')}
                </p>
                <Switch
                  aria-label={t(
                    'Reject arguments outside the schema when supported.'
                  )}
                  checked={tool.strict}
                  disabled={props.disabled}
                  onCheckedChange={(checked) =>
                    updateTool(tool.id, { strict: checked })
                  }
                />
              </div>
            </div>
          ))
        )}
        {draft.tools.length > 0 && (
          <div className='grid gap-1.5 px-1'>
            <Label htmlFor='playground-developer-tool-choice'>
              {t('Tool choice')}
            </Label>
            <Select
              items={toolChoiceItems}
              onValueChange={(value) => {
                if (typeof value !== 'string') return
                setDraft((current) => ({
                  ...current,
                  toolChoice: value as PlaygroundDeveloperToolChoice,
                }))
              }}
              value={draft.toolChoice}
            >
              <SelectTrigger
                disabled={props.disabled}
                id='playground-developer-tool-choice'
                size='sm'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {toolChoiceItems.map((item) => (
                    <SelectItem
                      key={item.value || 'provider-default'}
                      value={item.value}
                    >
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className='border-border/60 grid gap-2 border-t pt-3'>
        <p className='px-1 text-xs font-semibold'>{t('Response format')}</p>
        <div className='grid gap-1.5 px-1'>
          <Select
            items={responseFormatItems}
            onValueChange={(value) => {
              if (typeof value !== 'string') return
              setDraft((current) => ({
                ...current,
                responseFormatType:
                  value as PlaygroundDeveloperResponseFormat['type'],
              }))
            }}
            value={draft.responseFormatType}
          >
            <SelectTrigger
              aria-label={t('Response format')}
              disabled={props.disabled}
              size='sm'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {responseFormatItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {draft.responseFormatType === 'json_schema' && (
          <>
            <div className='grid gap-1.5 px-1'>
              <Label htmlFor='playground-developer-schema-name'>
                {t('Schema name')}
              </Label>
              <Input
                disabled={props.disabled}
                id='playground-developer-schema-name'
                maxLength={PLAYGROUND_DEVELOPER_NAME_MAX_LENGTH}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    schemaName: event.target.value,
                  }))
                }
                placeholder='order_summary'
                value={draft.schemaName}
              />
            </div>
            <div className='grid gap-1.5 px-1'>
              <Label htmlFor='playground-developer-schema-description'>
                {t('Description')}
              </Label>
              <Input
                disabled={props.disabled}
                id='playground-developer-schema-description'
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    schemaDescription: event.target.value,
                  }))
                }
                placeholder={t('What the response should contain.')}
                value={draft.schemaDescription}
              />
            </div>
            <div className='grid gap-1.5 px-1'>
              <Label htmlFor='playground-developer-schema-body'>
                {t('Schema (JSON)')}
              </Label>
              <Textarea
                className='max-h-60 min-h-28 font-mono text-xs'
                disabled={props.disabled}
                id='playground-developer-schema-body'
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    schemaText: event.target.value,
                  }))
                }
                placeholder={t('Describe the response as a JSON Schema.')}
                value={draft.schemaText}
              />
            </div>
            <div className='flex items-center justify-between gap-3 px-1'>
              <p className='text-muted-foreground text-xs leading-4'>
                {t('Reject values outside the schema when supported.')}
              </p>
              <Switch
                aria-label={t(
                  'Reject values outside the schema when supported.'
                )}
                checked={draft.schemaStrict}
                disabled={props.disabled}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({ ...current, schemaStrict: checked }))
                }
              />
            </div>
          </>
        )}
      </div>

      {error && (
        <p className='text-destructive px-1 text-xs leading-4' role='alert'>
          {t(error, developerErrorParams(error))}
        </p>
      )}

      <div className='flex justify-end px-1'>
        <Button
          disabled={props.disabled}
          onClick={save}
          size='sm'
          type='button'
        >
          {t('Save')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Request-side developer settings of the active conversation: the master
 * switch, the function tool definitions and the response format injected into
 * every send. The panel only edits a draft; saving stores it on the
 * conversation, and a disabled feature injects nothing.
 */
export function PlaygroundDeveloperPanel(props: PlaygroundDeveloperPanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const isActive = developerOptionsActive(props.options)

  const trigger = (
    <PromptInputButton
      aria-label={t('Developer settings')}
      aria-pressed={isActive}
      className='text-muted-foreground hover:text-foreground hover:bg-muted/70 relative font-medium'
      disabled={props.disabled}
      variant='ghost'
    >
      <Braces size={16} />
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
            <p>{t('Developer settings')}</p>
          </TooltipContent>
        </Tooltip>
        <SheetContent
          className='max-h-[85vh] overflow-hidden rounded-t-xl'
          side='bottom'
        >
          <SheetHeader>
            <SheetTitle>{t('Developer settings')}</SheetTitle>
          </SheetHeader>
          <div className='overflow-y-auto'>
            <PlaygroundDeveloperContent {...props} compact open={open} />
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
          <p>{t('Developer settings')}</p>
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
          <div className='text-sm font-semibold'>{t('Developer settings')}</div>
        </div>
        <PlaygroundDeveloperContent {...props} open={open} />
      </PopoverContent>
    </Popover>
  )
}
