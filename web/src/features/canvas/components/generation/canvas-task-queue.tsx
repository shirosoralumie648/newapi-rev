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
import { ArrowUpToLine, Clock3, ListOrdered, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { PlaygroundTaskQueueEntry } from '@/features/playground/generation-api'
import {
  useCancelPlaygroundTaskQueueEntry,
  usePlaygroundTaskQueue,
  usePrioritizePlaygroundTaskQueueEntry,
} from '@/features/playground/hooks'
import { formatUseTime } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

function queueStatusKey(entry: PlaygroundTaskQueueEntry): string {
  switch (entry.status) {
    case 'submitting':
      return 'Starting'
    case 'submitted':
      return 'Submitted'
    case 'failed':
      return 'Failed'
    case 'canceled':
      return 'Canceled'
    default:
      return 'Waiting'
  }
}

/**
 * Owner-scoped view of the optional server generation queue. The backend keeps
 * accepted submissions after the browser closes; this panel shows the current
 * position and advisory wait, and lets the owner cancel or move an entry before
 * a worker starts it. Once a worker reports the durable task id, the shared
 * task list has already been invalidated and carries the result from then on.
 */
export function CanvasTaskQueue() {
  const { t } = useTranslation()
  const queueQuery = usePlaygroundTaskQueue(true)
  const cancelEntry = useCancelPlaygroundTaskQueueEntry()
  const prioritizeEntry = usePrioritizePlaygroundTaskQueueEntry()
  const items = queueQuery.data?.items ?? []
  const waitingCount = items.filter(
    (entry) => entry.status === 'queued' || entry.status === 'submitting'
  ).length
  const busy = cancelEntry.isPending || prioritizeEntry.isPending

  if (!queueQuery.data?.enabled && items.length === 0) return null

  const handleCancel = async (entry: PlaygroundTaskQueueEntry) => {
    try {
      await cancelEntry.mutateAsync(entry.id)
    } catch (error) {
      handleServerError(error, t('Unable to cancel the queued generation.'))
    }
  }

  const handlePrioritize = async (entry: PlaygroundTaskQueueEntry) => {
    try {
      await prioritizeEntry.mutateAsync(entry.id)
    } catch (error) {
      handleServerError(error, t('Unable to move the queued generation.'))
    }
  }

  return (
    <section aria-label={t('Generation queue')} className='grid gap-2'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='flex items-center gap-2 text-sm font-medium'>
          <ListOrdered className='size-4' aria-hidden='true' />
          {t('Generation queue')}
        </h3>
        <span className='text-muted-foreground text-xs'>
          {t('Waiting: {{count}}', { count: waitingCount })}
        </span>
      </div>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Queued requests start automatically when a running task finishes. They are not charged while waiting; the normal pre-charge applies when a worker starts them.'
        )}
      </p>
      {items.length === 0 ? (
        <p className='text-muted-foreground text-sm' role='status'>
          {t('No generations are waiting in the queue.')}
        </p>
      ) : (
        <ul className='grid gap-2'>
          {items.map((entry) => {
            const isQueued = entry.status === 'queued'
            const canMove = isQueued && entry.position > 1
            return (
              <li
                className='border-border/70 grid gap-1 rounded-md border p-3'
                key={entry.id}
              >
                <div className='flex items-start justify-between gap-2'>
                  <div className='min-w-0'>
                    <p className='truncate text-sm font-medium'>
                      {entry.promptPreview || t('Untitled generation request')}
                    </p>
                    <p className='text-muted-foreground text-xs'>
                      {entry.model || t('Unknown model')} ·{' '}
                      {t(queueStatusKey(entry))}
                    </p>
                  </div>
                  <div className='flex shrink-0 items-center gap-1'>
                    {canMove ? (
                      <Button
                        aria-label={t('Move to front')}
                        disabled={busy}
                        onClick={() => void handlePrioritize(entry)}
                        size='icon-sm'
                        title={t('Move to front')}
                        variant='ghost'
                      >
                        <ArrowUpToLine className='size-4' aria-hidden='true' />
                      </Button>
                    ) : null}
                    {isQueued ? (
                      <Button
                        aria-label={t('Cancel queued generation')}
                        disabled={busy}
                        onClick={() => void handleCancel(entry)}
                        size='icon-sm'
                        title={t('Cancel queued generation')}
                        variant='ghost'
                      >
                        <X className='size-4' aria-hidden='true' />
                      </Button>
                    ) : null}
                    {entry.status === 'submitting' ? (
                      <Spinner className='size-4' />
                    ) : null}
                  </div>
                </div>
                {isQueued ? (
                  <p className='text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs'>
                    <span>
                      {t('Queue position: {{position}}', {
                        position: entry.position,
                      })}
                    </span>
                    <span className='flex items-center gap-1'>
                      <Clock3 className='size-3' aria-hidden='true' />
                      {t('Estimated wait: {{wait}}', {
                        wait: formatUseTime(entry.estimatedWaitSeconds),
                      })}
                    </span>
                  </p>
                ) : null}
                {entry.taskId ? (
                  <p className='text-muted-foreground text-xs'>
                    {t('Task id: {{taskId}}', { taskId: entry.taskId })}
                  </p>
                ) : null}
                {entry.errorMessage ? (
                  <p className='text-destructive text-xs' role='alert'>
                    {entry.errorMessage}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
