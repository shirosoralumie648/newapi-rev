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
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { formatTimestampToDate } from '@/lib/format'
import {
  getServerErrorMessage,
  isServerErrorCancelled,
} from '@/lib/server-error-message'

import {
  getPlaygroundComparisonRun,
  listPlaygroundComparisonRuns,
} from '../../comparison-api'
import { PLAYGROUND_COMPARISON_MESSAGES } from '../../constants'
import type {
  PlaygroundComparisonRun,
  PlaygroundComparisonRunSummary,
} from '../../types'
import {
  COMPARISON_RUN_STATUS_LABELS,
  COMPARISON_RUN_STATUS_VARIANTS,
} from './comparison-status'

type HistoryStatus = 'loading' | 'ready' | 'error'

interface PlaygroundComparisonHistoryProps {
  /** Loads the list only while the history tab is visible. */
  active: boolean
  disabled: boolean
  onLoad: (run: PlaygroundComparisonRun) => void
  onRemove: (runId: string) => Promise<boolean>
}

/**
 * Stored compare runs of the account. The list projection never carries a
 * matrix, so the full run is fetched only when the user opens one.
 */
export function PlaygroundComparisonHistory(
  props: PlaygroundComparisonHistoryProps
) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<HistoryStatus>('loading')
  const [items, setItems] = useState<PlaygroundComparisonRunSummary[]>([])
  const [errorText, setErrorText] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] =
    useState<PlaygroundComparisonRunSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!props.active) return
    const controller = new AbortController()
    setStatus('loading')
    setErrorText('')
    listPlaygroundComparisonRuns(controller.signal)
      .then((next) => {
        setItems(next)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (isServerErrorCancelled(error)) return
        setErrorText(
          getServerErrorMessage(
            error,
            PLAYGROUND_COMPARISON_MESSAGES.HISTORY_FAILED
          )
        )
        setStatus('error')
      })
    return () => controller.abort()
  }, [props.active, refreshKey])

  const openRun = async (summary: PlaygroundComparisonRunSummary) => {
    setLoadingId(summary.id)
    try {
      const run = await getPlaygroundComparisonRun(summary.id)
      props.onLoad(run)
    } catch (error: unknown) {
      if (isServerErrorCancelled(error)) return
      setErrorText(
        getServerErrorMessage(error, PLAYGROUND_COMPARISON_MESSAGES.LOAD_FAILED)
      )
      setStatus('error')
    } finally {
      setLoadingId(null)
    }
  }

  const confirmDelete = async () => {
    const target = deleteTarget
    if (!target) return
    setDeleting(true)
    const removed = await props.onRemove(target.id)
    setDeleting(false)
    setDeleteTarget(null)
    if (removed) {
      setItems((current) => current.filter((item) => item.id !== target.id))
    }
  }

  if (!props.active && status === 'loading') {
    return null
  }

  if (status === 'loading') {
    return (
      <div className='grid gap-1'>
        <LoadingState
          className='min-h-40'
          message={t('Loading comparison history...')}
        />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <ErrorState
        className='min-h-0'
        description={t(errorText)}
        onRetry={() => setRefreshKey((current) => current + 1)}
        title={t(PLAYGROUND_COMPARISON_MESSAGES.HISTORY_FAILED)}
      />
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        className='min-h-40'
        description={t('Saved comparison runs appear here.')}
        title={t('No comparison runs yet')}
      />
    )
  }

  return (
    <>
      <div className='divide-y rounded-md border'>
        {items.map((item) => (
          <div className='flex flex-wrap items-center gap-3 p-3' key={item.id}>
            <div className='min-w-0 flex-1'>
              <div className='flex min-w-0 items-center gap-2'>
                <span className='truncate text-sm font-medium'>
                  {item.title}
                </span>
                <StatusBadge
                  copyable={false}
                  label={t(COMPARISON_RUN_STATUS_LABELS[item.status])}
                  pulse={item.status === 'running'}
                  variant={COMPARISON_RUN_STATUS_VARIANTS[item.status]}
                />
              </div>
              <p className='text-muted-foreground text-xs'>
                {t('{{models}} models x {{prompts}} prompts', {
                  models: item.modelCount,
                  prompts: item.promptCount,
                })}
                {' · '}
                {formatTimestampToDate(item.createdAt)}
              </p>
            </div>
            <Button
              disabled={props.disabled || loadingId !== null}
              onClick={() => void openRun(item)}
              size='sm'
              type='button'
              variant='outline'
            >
              {loadingId === item.id && <Spinner aria-hidden='true' />}
              {t('Open')}
            </Button>
            <Button
              aria-label={t('Delete {{name}}', { name: item.title })}
              disabled={props.disabled}
              onClick={() => setDeleteTarget(item)}
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <Trash2 aria-hidden='true' />
            </Button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        destructive
        desc={t(
          'The stored matrix and its account counters are released. This cannot be undone.'
        )}
        handleConfirm={() => void confirmDelete()}
        isLoading={deleting}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
        title={t('Delete this comparison run?')}
        confirmText={t('Delete')}
      />
    </>
  )
}
