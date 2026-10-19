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

import {
  PLAYGROUND_EMBEDDING_MAX_INPUTS,
  PLAYGROUND_EMBEDDING_MAX_INPUT_CHARS,
} from '../../constants'
import {
  NON_CHAT_MAX_SIMILARITY_VECTORS,
  formatNonChatScore,
  pairwiseCosineSimilarities,
  parseNonChatLines,
} from '../../lib/tools/nonchat'
import {
  runEmbeddings,
  type PlaygroundEmbeddingResponse,
  type PlaygroundNonChatOutcome,
} from '../../tools-api'
import { NonChatRequestCode } from './playground-nonchat-request-code'
import {
  NonChatResultJson,
  NonChatResultMeta,
  nonChatIssueMessage,
} from './playground-nonchat-shared'

const VECTOR_PREVIEW_LENGTH = 6

export function PlaygroundEmbeddingTool(props: {
  group: string
  model: string
  userId: number | null
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const [inputText, setInputText] = useState('')
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] =
    useState<PlaygroundNonChatOutcome<PlaygroundEmbeddingResponse> | null>(null)
  const [lastRequest, setLastRequest] = useState<Record<
    string,
    unknown
  > | null>(null)

  const validation = useMemo(
    () =>
      parseNonChatLines(
        inputText,
        PLAYGROUND_EMBEDDING_MAX_INPUTS,
        PLAYGROUND_EMBEDDING_MAX_INPUT_CHARS
      ),
    [inputText]
  )
  const items = outcome?.data.items ?? []
  const dimensions = items[0]?.embedding.length ?? null
  const similarityItems = items.slice(0, NON_CHAT_MAX_SIMILARITY_VECTORS)
  const similarityPairs = useMemo(
    () =>
      pairwiseCosineSimilarities(
        items
          .slice(0, NON_CHAT_MAX_SIMILARITY_VECTORS)
          .map((item) => item.embedding)
      ),
    [items]
  )
  const canRun =
    !running && props.model.trim().length > 0 && props.group.length > 0

  async function handleRun() {
    if (!canRun || validation.issue) return
    const body = {
      model: props.model.trim(),
      group: props.group,
      input: validation.values,
    }
    setRunning(true)
    setLastRequest(body)
    try {
      const result = await runEmbeddings(
        {
          model: body.model,
          group: body.group,
          inputs: body.input,
        },
        undefined
      )
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
          <Label htmlFor='playground-embedding-inputs'>{t('Inputs')}</Label>
          <Textarea
            className='min-h-40 font-mono text-xs'
            id='playground-embedding-inputs'
            onChange={(event) => setInputText(event.target.value)}
            placeholder={t('One input per line.')}
            value={inputText}
          />
          <p className='text-muted-foreground text-xs'>
            {t(
              'One input per line. Up to {{count}} inputs, {{length}} characters each.',
              {
                count: PLAYGROUND_EMBEDDING_MAX_INPUTS,
                length: PLAYGROUND_EMBEDDING_MAX_INPUT_CHARS,
              }
            )}
          </p>
        </div>
        {validation.issue ? (
          <p className='text-destructive text-sm' role='alert'>
            {nonChatIssueMessage(t, validation.issue, {
              count: PLAYGROUND_EMBEDDING_MAX_INPUTS,
              length: PLAYGROUND_EMBEDDING_MAX_INPUT_CHARS,
            })}
          </p>
        ) : null}
        <Button
          disabled={!canRun || validation.issue !== undefined}
          onClick={handleRun}
          type='button'
        >
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
            canonicalPath='/v1/embeddings'
          />
        </div>
      </div>

      <div className='space-y-3'>
        {outcome ? (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant='secondary'>
                {t('{{count}} inputs', { count: items.length })}
              </Badge>
              {dimensions !== null ? (
                <Badge variant='secondary'>
                  {t('{{count}} dimensions', { count: dimensions })}
                </Badge>
              ) : null}
            </div>
            <NonChatResultMeta
              requestId={outcome.requestId}
              userId={props.userId}
            />
            {items.length === 0 ? (
              <p className='text-muted-foreground text-sm'>
                {t('The model returned no embeddings.')}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-16'>{t('Input')}</TableHead>
                      <TableHead className='w-20'>{t('Dimensions')}</TableHead>
                      <TableHead>{t('Vector preview')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.index}>
                        <TableCell className='tabular-nums'>
                          {item.index + 1}
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {item.embedding.length}
                        </TableCell>
                        <TableCell className='font-mono text-xs'>
                          {item.embedding
                            .slice(0, VECTOR_PREVIEW_LENGTH)
                            .map((value) => formatNonChatScore(value, locale))
                            .join(', ')}
                          {item.embedding.length > VECTOR_PREVIEW_LENGTH
                            ? ', …'
                            : ''}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {similarityPairs.length > 0 ? (
                  <div className='space-y-2'>
                    <p className='text-sm font-medium'>
                      {t('Pairwise cosine similarity')}
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead />
                          {similarityItems.map((item) => (
                            <TableHead key={item.index} className='text-center'>
                              {t('Input {{index}}', { index: item.index + 1 })}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {similarityItems.map((rowItem, rowIndex) => (
                          <TableRow key={rowItem.index}>
                            <TableCell className='font-medium'>
                              {t('Input {{index}}', {
                                index: rowItem.index + 1,
                              })}
                            </TableCell>
                            {similarityItems.map((columnItem, columnIndex) => {
                              if (columnIndex <= rowIndex) {
                                return (
                                  <TableCell
                                    key={columnItem.index}
                                    className='text-muted-foreground text-center'
                                  >
                                    -
                                  </TableCell>
                                )
                              }
                              const pair = similarityPairs.find(
                                (candidate) =>
                                  candidate.left === rowIndex &&
                                  candidate.right === columnIndex
                              )
                              return (
                                <TableCell
                                  key={columnItem.index}
                                  className='text-center tabular-nums'
                                >
                                  {formatNonChatScore(pair?.value, locale)}
                                </TableCell>
                              )
                            })}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {items.length > NON_CHAT_MAX_SIMILARITY_VECTORS ? (
                      <p className='text-muted-foreground text-xs'>
                        {t(
                          'Showing similarities for the first {{count}} vectors.',
                          { count: NON_CHAT_MAX_SIMILARITY_VECTORS }
                        )}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
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
