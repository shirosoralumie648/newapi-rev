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
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatTimestampToDate } from '@/lib/format'
import { getServerMessage } from '@/lib/server-error-message'

import { PLAYGROUND_SNIPPET_ERRORS } from '../../constants'
import { diffPromptTemplateLines } from '../../lib/input/prompt-diff'
import type { PromptSnippetDetail, PromptSnippetVersion } from '../../types'
import { PlaygroundPromptDiff } from './playground-prompt-diff'

type HistoryStatus = 'loading' | 'ready' | 'error'

interface PlaygroundSnippetHistoryDialogProps {
  open: boolean
  snippet: PromptSnippetDetail | null
  status: HistoryStatus
  error: Error | null
  rollingBackVersion: number | null
  onOpenChange: (open: boolean) => void
  onRetry: () => void
  onRollback: (version: number) => void
}

function previousVersionContent(
  versions: PromptSnippetVersion[],
  version: PromptSnippetVersion
): string {
  return (
    versions.find((candidate) => candidate.version === version.version - 1)
      ?.content ?? ''
  )
}

/**
 * The revision browser of one prompt template. It shows every immutable
 * version newest first, a line diff against its predecessor, and the movable
 * production pointer with a rollback action that never rewrites history.
 */
export function PlaygroundSnippetHistoryDialog(
  props: PlaygroundSnippetHistoryDialogProps
) {
  const { t } = useTranslation()
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null)

  useEffect(() => {
    if (!props.open) {
      setExpandedVersion(null)
      setRollbackTarget(null)
    }
  }, [props.open])

  useEffect(() => {
    setExpandedVersion(null)
  }, [props.snippet?.id])

  const versions = props.snippet?.versions ?? []
  const ordered = [...versions].sort(
    (left, right) => right.version - left.version
  )

  return (
    <>
      <Dialog
        contentClassName='sm:max-w-3xl'
        description={t(
          'Every save stores an immutable version. Rollback only moves the production pointer.'
        )}
        footer={
          <Button
            onClick={() => props.onOpenChange(false)}
            type='button'
            variant='outline'
          >
            {t('Close')}
          </Button>
        }
        onOpenChange={props.onOpenChange}
        open={props.open}
        title={t('Version history')}
      >
        {props.status === 'loading' ? (
          <LoadingState className='min-h-40' />
        ) : null}

        {props.status === 'error' ? (
          <ErrorState
            description={
              getServerMessage(props.error) ??
              t(PLAYGROUND_SNIPPET_ERRORS.VERSIONS_FAILED)
            }
            onRetry={props.onRetry}
            title={t(PLAYGROUND_SNIPPET_ERRORS.VERSIONS_FAILED)}
          />
        ) : null}

        {props.status === 'ready' ? (
          <ScrollArea className='max-h-[60vh] min-h-0'>
            <ol className='grid gap-2 pe-2'>
              {ordered.map((version) => {
                const expanded = expandedVersion === version.version
                const isProduction =
                  props.snippet?.productionVersion === version.version
                return (
                  <li
                    className='bg-card rounded-md border p-2'
                    key={version.version}
                  >
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <button
                        aria-expanded={expanded}
                        className='flex min-w-0 items-center gap-2 text-start'
                        onClick={() =>
                          setExpandedVersion(expanded ? null : version.version)
                        }
                        type='button'
                      >
                        {expanded ? (
                          <ChevronDown aria-hidden='true' className='size-4' />
                        ) : (
                          <ChevronRight aria-hidden='true' className='size-4' />
                        )}
                        <span className='font-mono text-sm font-medium'>
                          v{version.version}
                        </span>
                        {isProduction ? (
                          <Badge variant='secondary'>
                            {t('In production')}
                          </Badge>
                        ) : null}
                        {props.snippet?.currentVersion === version.version &&
                        !isProduction ? (
                          <Badge variant='outline'>
                            {t('Current version')}
                          </Badge>
                        ) : null}
                        <span className='text-muted-foreground text-xs'>
                          {t('{{count}} characters', {
                            count: version.byteSize,
                          })}
                        </span>
                        <span className='text-muted-foreground text-xs'>
                          {formatTimestampToDate(
                            version.createdAt,
                            'milliseconds'
                          )}
                        </span>
                      </button>
                      {!isProduction ? (
                        <Button
                          disabled={props.rollingBackVersion !== null}
                          onClick={() => setRollbackTarget(version.version)}
                          size='sm'
                          type='button'
                          variant='outline'
                        >
                          <RotateCcw aria-hidden='true' />
                          {t('Roll back to this version')}
                        </Button>
                      ) : null}
                    </div>

                    {expanded ? (
                      version.version <= 1 ? (
                        <p className='text-muted-foreground mt-2 text-xs'>
                          {t('Initial version')}
                        </p>
                      ) : (
                        <div className='mt-2'>
                          <p className='text-muted-foreground mb-1 text-xs'>
                            {t('Compared with version {{version}}', {
                              version: version.version - 1,
                            })}
                          </p>
                          <PlaygroundPromptDiff
                            lines={diffPromptTemplateLines(
                              previousVersionContent(versions, version),
                              version.content
                            )}
                          />
                        </div>
                      )
                    ) : null}
                  </li>
                )
              })}
            </ol>
          </ScrollArea>
        ) : null}
      </Dialog>

      <ConfirmDialog
        confirmText={t('Roll back')}
        desc={t(
          'The template publishes this version. Every stored version stays available.'
        )}
        handleConfirm={() => {
          if (rollbackTarget !== null) props.onRollback(rollbackTarget)
          setRollbackTarget(null)
        }}
        isLoading={props.rollingBackVersion !== null}
        onOpenChange={(next) => {
          if (!next && props.rollingBackVersion === null) {
            setRollbackTarget(null)
          }
        }}
        open={rollbackTarget !== null}
        title={t('Roll back to version {{version}}?', {
          version: rollbackTarget ?? '',
        })}
      />
    </>
  )
}
