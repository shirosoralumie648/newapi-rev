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

import {
  PLAYGROUND_RERANK_MAX_CANDIDATE_CHARS,
  PLAYGROUND_RERANK_MAX_CANDIDATES,
  PLAYGROUND_RERANK_MAX_QUERY_CHARS,
} from '../../constants'
import {
  formatNonChatScore,
  parseNonChatLines,
  sortRerankItems,
} from '../../lib/tools/nonchat'
import {
  runRerank,
  type PlaygroundNonChatOutcome,
  type PlaygroundRerankResponse,
} from '../../tools-api'
import { NonChatRequestCode } from './playground-nonchat-request-code'
import {
  NonChatResultJson,
  NonChatResultMeta,
  nonChatIssueMessage,
} from './playground-nonchat-shared'

function candidateText(
  item: PlaygroundRerankResponse['results'][number],
  documents: string[]
): string {
  const local = documents[item.index]
  if (local !== undefined) return local
  if (typeof item.document === 'string') return item.document
  if (item.document !== undefined) return JSON.stringify(item.document)
  return ''
}

export function PlaygroundRerankTool(props: {
  group: string
  model: string
  userId: number | null
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language)
  const [query, setQuery] = useState('')
  const [candidateTexts, setCandidateTexts] = useState('')
  const [topNText, setTopNText] = useState('')
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] =
    useState<PlaygroundNonChatOutcome<PlaygroundRerankResponse> | null>(null)
  const [lastRequest, setLastRequest] = useState<Record<
    string,
    unknown
  > | null>(null)

  const candidates = useMemo(
    () =>
      parseNonChatLines(
        candidateTexts,
        PLAYGROUND_RERANK_MAX_CANDIDATES,
        PLAYGROUND_RERANK_MAX_CANDIDATE_CHARS
      ),
    [candidateTexts]
  )
  const trimmedQuery = query.trim()
  const topN = useMemo(() => {
    const trimmed = topNText.trim()
    if (!trimmed) return undefined
    const value = Number(trimmed)
    if (!Number.isInteger(value) || value < 1) return null
    if (candidates.values.length > 0 && value > candidates.values.length) {
      return null
    }
    return value
  }, [candidates.values.length, topNText])
  const canRun =
    !running &&
    props.model.trim().length > 0 &&
    props.group.length > 0 &&
    trimmedQuery.length > 0 &&
    trimmedQuery.length <= PLAYGROUND_RERANK_MAX_QUERY_CHARS &&
    candidates.issue === undefined &&
    topN !== null
  const results = outcome ? sortRerankItems(outcome.data.results) : []
  const submittedDocuments =
    (lastRequest?.documents as string[] | undefined) ?? candidates.values

  async function handleRun() {
    if (!canRun || topN === null) return
    const body = {
      model: props.model.trim(),
      group: props.group,
      query: trimmedQuery,
      documents: candidates.values,
      ...(topN !== undefined ? { top_n: topN } : {}),
    }
    setRunning(true)
    setLastRequest(body)
    try {
      const result = await runRerank({
        model: body.model,
        group: body.group,
        query: body.query,
        documents: body.documents,
        topN,
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
          <Label htmlFor='playground-rerank-query'>{t('Query')}</Label>
          <Textarea
            className='min-h-20 text-xs'
            id='playground-rerank-query'
            onChange={(event) => setQuery(event.target.value)}
            value={query}
          />
          {trimmedQuery.length > PLAYGROUND_RERANK_MAX_QUERY_CHARS ? (
            <p className='text-destructive text-sm' role='alert'>
              {t('The query must be at most {{length}} characters.', {
                length: PLAYGROUND_RERANK_MAX_QUERY_CHARS,
              })}
            </p>
          ) : null}
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='playground-rerank-candidates'>
            {t('Candidates')}
          </Label>
          <Textarea
            className='min-h-40 font-mono text-xs'
            id='playground-rerank-candidates'
            onChange={(event) => setCandidateTexts(event.target.value)}
            placeholder={t('One candidate per line.')}
            value={candidateTexts}
          />
          <p className='text-muted-foreground text-xs'>
            {t(
              'One candidate per line. Up to {{count}} candidates, {{length}} characters each.',
              {
                count: PLAYGROUND_RERANK_MAX_CANDIDATES,
                length: PLAYGROUND_RERANK_MAX_CANDIDATE_CHARS,
              }
            )}
          </p>
          {candidates.issue ? (
            <p className='text-destructive text-sm' role='alert'>
              {nonChatIssueMessage(t, candidates.issue, {
                count: PLAYGROUND_RERANK_MAX_CANDIDATES,
                length: PLAYGROUND_RERANK_MAX_CANDIDATE_CHARS,
              })}
            </p>
          ) : null}
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='playground-rerank-top-n'>{t('Top N')}</Label>
          <Input
            className='w-32'
            id='playground-rerank-top-n'
            inputMode='numeric'
            min={1}
            onChange={(event) => setTopNText(event.target.value)}
            placeholder={t('Optional')}
            type='number'
            value={topNText}
          />
          {topN === null ? (
            <p className='text-destructive text-sm' role='alert'>
              {t('Top N must be between 1 and the number of candidates.')}
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
                query: trimmedQuery,
                documents: candidates.values,
                ...(topN !== undefined && topN !== null ? { top_n: topN } : {}),
              }
            }
            canonicalPath='/v1/rerank'
          />
        </div>
      </div>

      <div className='space-y-3'>
        {outcome ? (
          <>
            <Badge variant='secondary'>
              {t('{{count}} results', { count: results.length })}
            </Badge>
            <NonChatResultMeta
              requestId={outcome.requestId}
              userId={props.userId}
            />
            {results.length === 0 ? (
              <p className='text-muted-foreground text-sm'>
                {t('The model returned no rerank results.')}
              </p>
            ) : (
              <>
                <p className='text-muted-foreground text-xs'>
                  {t('Sorted by relevance score, highest first.')}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-16'>{t('Rank')}</TableHead>
                      <TableHead>{t('Candidate')}</TableHead>
                      <TableHead className='w-24'>{t('Score')}</TableHead>
                      <TableHead className='w-24'>
                        {t('Original index')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((item, position) => (
                      <TableRow key={`${item.index}-${position}`}>
                        <TableCell className='tabular-nums'>
                          {position + 1}
                        </TableCell>
                        <TableCell className='max-w-80 truncate'>
                          {candidateText(item, submittedDocuments)}
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {formatNonChatScore(item.score, locale)}
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {item.index}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
