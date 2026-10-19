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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { handleServerError } from '@/lib/handle-server-error'
import { cn } from '@/lib/utils'

import {
  PLAYGROUND_MODERATION_MAX_INPUT_CHARS,
  PLAYGROUND_MODERATION_MAX_INPUTS,
} from '../../constants'
import {
  formatNonChatScore,
  moderationCategoryRows,
  parseNonChatLines,
} from '../../lib/tools/nonchat'
import {
  runModerations,
  type PlaygroundModerationResponse,
  type PlaygroundNonChatOutcome,
} from '../../tools-api'
import { NonChatRequestCode } from './playground-nonchat-request-code'
import {
  NonChatResultJson,
  NonChatResultMeta,
  nonChatIssueMessage,
} from './playground-nonchat-shared'

const DEFAULT_THRESHOLD = 0.5

export function PlaygroundModerationTool(props: {
  group: string
  model: string
  userId: number | null
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const [inputText, setInputText] = useState('')
  const [thresholdText, setThresholdText] = useState(String(DEFAULT_THRESHOLD))
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] =
    useState<PlaygroundNonChatOutcome<PlaygroundModerationResponse> | null>(
      null
    )
  const [lastRequest, setLastRequest] = useState<Record<
    string,
    unknown
  > | null>(null)

  const validation = useMemo(
    () =>
      parseNonChatLines(
        inputText,
        PLAYGROUND_MODERATION_MAX_INPUTS,
        PLAYGROUND_MODERATION_MAX_INPUT_CHARS
      ),
    [inputText]
  )
  const threshold = Number(thresholdText)
  const thresholdValid =
    thresholdText.trim().length > 0 &&
    Number.isFinite(threshold) &&
    threshold >= 0 &&
    threshold <= 1
  const canRun =
    !running &&
    props.model.trim().length > 0 &&
    props.group.length > 0 &&
    validation.issue === undefined
  const submittedInputs =
    (lastRequest?.input as string[] | undefined) ?? validation.values

  async function handleRun() {
    if (!canRun) return
    const body = {
      model: props.model.trim(),
      group: props.group,
      input: validation.values,
    }
    setRunning(true)
    setLastRequest(body)
    try {
      const result = await runModerations({
        model: body.model,
        group: body.group,
        inputs: body.input,
      })
      setOutcome(result)
    } catch (error) {
      handleServerError(error, t('Request failed'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className='grid gap-4 lg:grid-cols-2'>
      <div className='space-y-3'>
        <div className='space-y-1.5'>
          <Label htmlFor='playground-moderation-inputs'>{t('Text')}</Label>
          <Textarea
            className='min-h-40 font-mono text-xs'
            id='playground-moderation-inputs'
            onChange={(event) => setInputText(event.target.value)}
            placeholder={t('One input per line.')}
            value={inputText}
          />
          <p className='text-muted-foreground text-xs'>
            {t(
              'One input per line. Up to {{count}} inputs, {{length}} characters each.',
              {
                count: PLAYGROUND_MODERATION_MAX_INPUTS,
                length: PLAYGROUND_MODERATION_MAX_INPUT_CHARS,
              }
            )}
          </p>
          {validation.issue ? (
            <p className='text-destructive text-sm' role='alert'>
              {nonChatIssueMessage(t, validation.issue, {
                count: PLAYGROUND_MODERATION_MAX_INPUTS,
                length: PLAYGROUND_MODERATION_MAX_INPUT_CHARS,
              })}
            </p>
          ) : null}
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='playground-moderation-threshold'>
            {t('Local threshold')}
          </Label>
          <Input
            className='w-32'
            id='playground-moderation-threshold'
            inputMode='decimal'
            max={1}
            min={0}
            onChange={(event) => setThresholdText(event.target.value)}
            step={0.05}
            type='number'
            value={thresholdText}
          />
          <p className='text-muted-foreground text-xs'>
            {t(
              "Categories at or above this score are highlighted locally. The provider's flagged decision is authoritative."
            )}
          </p>
          {!thresholdValid ? (
            <p className='text-destructive text-sm' role='alert'>
              {t('The threshold must be between 0 and 1.')}
            </p>
          ) : null}
        </div>
        <Button disabled={!canRun} onClick={handleRun} type='button'>
          {running ? t('Running...') : t('Run')}
        </Button>
        <div className='border-t pt-3'>
          <NonChatRequestCode
            body={
              lastRequest ?? {
                model: props.model.trim(),
                group: props.group,
                input: validation.values,
              }
            }
            canonicalPath='/v1/moderations'
          />
        </div>
      </div>

      <div className='space-y-3'>
        {outcome ? (
          <>
            <Badge variant='secondary'>
              {t('{{count}} results', { count: outcome.data.results.length })}
            </Badge>
            <NonChatResultMeta
              requestId={outcome.requestId}
              userId={props.userId}
            />
            {outcome.data.results.length === 0 ? (
              <p className='text-muted-foreground text-sm'>
                {t('The model returned no moderation results.')}
              </p>
            ) : (
              outcome.data.results.map((result, index) => {
                const categories = moderationCategoryRows(result, threshold)
                return (
                  <div
                    className='space-y-2 rounded-lg border p-3'
                    key={`${index}-${submittedInputs[index] ?? ''}`}
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <p className='min-w-0 truncate text-sm font-medium'>
                        {t('Input {{index}}', { index: index + 1 })}:{' '}
                        <span className='text-muted-foreground font-normal'>
                          {submittedInputs[index] ?? ''}
                        </span>
                      </p>
                      <Badge
                        variant={result.flagged ? 'destructive' : 'secondary'}
                      >
                        {result.flagged ? t('Flagged') : t('Not flagged')}
                      </Badge>
                    </div>
                    <p className='text-muted-foreground text-xs'>
                      {t('Provider decision')}:{' '}
                      {result.flagged ? t('Flagged') : t('Not flagged')}
                    </p>
                    {categories.length === 0 ? (
                      <p className='text-muted-foreground text-sm'>
                        {t('No categories were returned.')}
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('Category')}</TableHead>
                            <TableHead className='w-24'>{t('Score')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {categories.map((category) => (
                            <TableRow
                              className={cn(
                                category.highlighted && 'bg-destructive/10'
                              )}
                              key={category.name}
                            >
                              <TableCell>{category.name}</TableCell>
                              <TableCell className='tabular-nums'>
                                {formatNonChatScore(category.score, locale)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                )
              })
            )}
            <NonChatResultJson raw={outcome.raw} />
          </>
        ) : (
          <p className='text-muted-foreground text-sm'>
            {t('No results yet.')}
          </p>
        )}
      </div>
    </div>
  )
}
