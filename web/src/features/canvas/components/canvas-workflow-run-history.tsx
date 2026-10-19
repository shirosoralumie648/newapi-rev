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
import { ChevronLeft, RefreshCw, RotateCcw, Trash2, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { TimestampCell } from '@/components/activity-time-cell'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { StatusBadge } from '@/components/status-badge'
import type { StatusVariant } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { toIntlLocale } from '@/i18n/languages'
import { formatLogQuota, formatTokens, formatUseTime } from '@/lib/format'
import {
  getServerErrorMessage,
  isServerErrorCancelled,
} from '@/lib/server-error-message'

import {
  deleteCanvasWorkflowRun,
  getCanvasWorkflowRun,
  listCanvasWorkflowRuns,
} from '../api'
import {
  diffCanvasWorkflowRuns,
  type CanvasWorkflowRunDiffRow,
} from '../lib/canvas-workflow-cache'
import type {
  CanvasWorkflowRun,
  CanvasWorkflowRunNodeRecord,
  CanvasWorkflowRunStatus,
  CanvasWorkflowRunSummary,
} from '../types'

type HistoryStatus = 'loading' | 'ready' | 'error'

const RUN_STATUS_LABELS: Record<CanvasWorkflowRunStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
}

const RUN_STATUS_VARIANTS: Record<CanvasWorkflowRunStatus, StatusVariant> = {
  running: 'info',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

const NODE_STATUS_LABELS: Record<
  CanvasWorkflowRunNodeRecord['status'],
  string
> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
  skipped: 'Skipped',
}

interface CanvasWorkflowRunHistoryProps {
  active: boolean
  canvasId: string
  disabled?: boolean
  running: boolean
  /** Row of the current or latest run; used to load the rerun comparison. */
  lastRunId: string | null
  /** Changes when the runner finalized a snapshot. */
  refreshKey: number
  onRestoreCache: (run: CanvasWorkflowRun) => void
  onRerun: (run: CanvasWorkflowRun) => void
}

/**
 * Persisted workflow runs of one canvas. The list is a metadata projection;
 * opening a row loads its node waterfall. A forced rerun stores the selected
 * run as the comparison baseline and shows the node-level diff when the new
 * run finishes.
 */
export function CanvasWorkflowRunHistory(props: CanvasWorkflowRunHistoryProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [status, setStatus] = useState<HistoryStatus>('loading')
  const [items, setItems] = useState<CanvasWorkflowRunSummary[]>([])
  const [errorText, setErrorText] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [selected, setSelected] = useState<CanvasWorkflowRun | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] =
    useState<CanvasWorkflowRunSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [comparisonBase, setComparisonBase] =
    useState<CanvasWorkflowRun | null>(null)
  const [comparison, setComparison] = useState<
    CanvasWorkflowRunDiffRow[] | null
  >(null)
  const sawRerunRef = useRef(false)

  useEffect(() => {
    if (!props.active) return
    const controller = new AbortController()
    setStatus('loading')
    setErrorText('')
    listCanvasWorkflowRuns(props.canvasId, controller.signal)
      .then((next) => {
        setItems(next)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (isServerErrorCancelled(error)) return
        setErrorText(
          getServerErrorMessage(error, 'Unable to load run history.')
        )
        setStatus('error')
      })
    return () => controller.abort()
  }, [props.active, props.canvasId, props.refreshKey, reloadKey])

  useEffect(() => {
    if (props.running && comparisonBase) sawRerunRef.current = true
  }, [comparisonBase, props.running])

  useEffect(() => {
    if (
      !props.active ||
      props.running ||
      !sawRerunRef.current ||
      !comparisonBase ||
      !props.lastRunId ||
      props.lastRunId === comparisonBase.id
    ) {
      return
    }
    const controller = new AbortController()
    sawRerunRef.current = false
    void getCanvasWorkflowRun(props.lastRunId, controller.signal)
      .then((run) => {
        if (!controller.signal.aborted) {
          setComparison(diffCanvasWorkflowRuns(comparisonBase, run))
        }
      })
      .catch(() => {
        // The new run may have been deleted or the canvas left meanwhile; the
        // history panel simply keeps showing the selected run.
      })
    return () => controller.abort()
  }, [comparisonBase, props.active, props.lastRunId, props.running])

  const openRun = async (summary: CanvasWorkflowRunSummary) => {
    setLoadingId(summary.id)
    try {
      const run = await getCanvasWorkflowRun(summary.id)
      setSelected(run)
      setComparison(null)
    } catch (error: unknown) {
      if (isServerErrorCancelled(error)) return
      toast.error(
        t(getServerErrorMessage(error, 'The workflow run could not be loaded.'))
      )
    } finally {
      setLoadingId(null)
    }
  }

  const rerun = (run: CanvasWorkflowRun) => {
    setComparisonBase(run)
    setComparison(null)
    sawRerunRef.current = false
    props.onRerun(run)
  }

  const restore = (run: CanvasWorkflowRun) => {
    props.onRestoreCache(run)
    toast.success(
      t('The next run will reuse the successful steps of this run.')
    )
  }

  const confirmDelete = async () => {
    const target = deleteTarget
    if (!target) return
    setDeleting(true)
    try {
      await deleteCanvasWorkflowRun(target.id)
      setItems((current) => current.filter((item) => item.id !== target.id))
      if (selected?.id === target.id) setSelected(null)
      if (comparisonBase?.id === target.id) {
        setComparisonBase(null)
        setComparison(null)
      }
      toast.success(t('Run deleted from history.'))
    } catch (error: unknown) {
      toast.error(
        t(
          getServerErrorMessage(error, 'The workflow run could not be deleted.')
        )
      )
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  if (selected) {
    return (
      <RunDetail
        comparison={comparison}
        locale={locale}
        onBack={() => setSelected(null)}
        onDelete={() => {
          const summary = items.find((item) => item.id === selected.id)
          if (summary) setDeleteTarget(summary)
        }}
        onRerun={() => rerun(selected)}
        onRestore={() => restore(selected)}
        run={selected}
      >
        <ConfirmDialog
          confirmText={t('Delete')}
          desc={t(
            'Deleting this run removes its stored snapshot and cache entries.'
          )}
          handleConfirm={() => void confirmDelete()}
          isLoading={deleting}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
          open={deleteTarget !== null}
          title={t('Delete this run?')}
        />
      </RunDetail>
    )
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='text-sm font-medium'>{t('Run history')}</span>
        <Button
          aria-label={t('Refresh run history')}
          disabled={status === 'loading'}
          onClick={() => setReloadKey((current) => current + 1)}
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <RefreshCw aria-hidden='true' />
        </Button>
      </div>
      <ScrollArea className='min-h-0 flex-1'>
        <div className='grid gap-2 p-3'>
          {status === 'loading' && <LoadingState className='min-h-32' />}
          {status === 'error' && (
            <ErrorState
              className='min-h-32'
              description={t(errorText)}
              onRetry={() => setReloadKey((current) => current + 1)}
              title={t('Unable to load run history.')}
            />
          )}
          {status === 'ready' && items.length === 0 && (
            <EmptyState
              className='min-h-32'
              description={t(
                'Runs started from this canvas appear here and can be reused.'
              )}
              title={t('No workflow runs yet')}
            />
          )}
          {status === 'ready' &&
            items.map((item) => (
              <button
                className='hover:bg-muted/60 grid w-full min-w-0 gap-1 rounded-lg border p-3 text-left transition-colors'
                key={item.id}
                onClick={() => void openRun(item)}
                type='button'
              >
                <div className='flex min-w-0 items-center justify-between gap-2'>
                  <span className='truncate text-sm font-medium'>
                    {t('Revision {{revision}}', {
                      revision: item.workflowRevision,
                    })}
                  </span>
                  <StatusBadge
                    copyable={false}
                    label={t(RUN_STATUS_LABELS[item.status])}
                    pulse={item.status === 'running'}
                    variant={RUN_STATUS_VARIANTS[item.status]}
                  />
                </div>
                <div className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs'>
                  <TimestampCell
                    justNowLabel={t('Just now')}
                    locale={locale}
                    timestamp={item.createdAt / 1000}
                  />
                  <span>{t('{{count}} steps', { count: item.nodeCount })}</span>
                  <span>
                    {t('{{count}} cached', { count: item.cacheHits })}
                  </span>
                  <span>{formatLogQuota(item.totalQuota)}</span>
                  <span>{formatUseTime(item.durationMs / 1000)}</span>
                </div>
                {loadingId === item.id && (
                  <span className='text-muted-foreground flex items-center gap-1 text-xs'>
                    <Spinner /> {t('Loading run...')}
                  </span>
                )}
              </button>
            ))}
        </div>
      </ScrollArea>
    </div>
  )
}

interface RunDetailProps {
  run: CanvasWorkflowRun
  locale: string
  comparison: CanvasWorkflowRunDiffRow[] | null
  onBack: () => void
  onRestore: () => void
  onRerun: () => void
  onDelete: () => void
  children?: ReactNode
}

function RunDetail(props: RunDetailProps) {
  const { t } = useTranslation()
  const { run } = props
  const changedComparison = (props.comparison ?? []).filter(
    (row) => row.changed
  )

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-3 py-2'>
        <Button
          aria-label={t('Back to run history')}
          onClick={props.onBack}
          size='icon-sm'
          type='button'
          variant='ghost'
        >
          <ChevronLeft aria-hidden='true' />
        </Button>
        <div className='min-w-0 flex-1'>
          <div className='flex min-w-0 items-center gap-2'>
            <span className='truncate text-sm font-medium'>
              {t('Revision {{revision}}', {
                revision: run.workflowRevision,
              })}
            </span>
            <StatusBadge
              copyable={false}
              label={t(RUN_STATUS_LABELS[run.status])}
              pulse={run.status === 'running'}
              variant={RUN_STATUS_VARIANTS[run.status]}
            />
          </div>
          <TimestampCell
            className='text-muted-foreground text-xs'
            justNowLabel={t('Just now')}
            locale={props.locale}
            timestamp={run.createdAt / 1000}
          />
        </div>
      </div>

      <ScrollArea className='min-h-0 flex-1'>
        <div className='grid gap-3 p-3'>
          <div className='grid grid-cols-2 gap-2 text-xs'>
            <Metric
              label={t('Total cost')}
              value={formatLogQuota(run.totalQuota)}
            />
            <Metric
              label={t('Cache hits')}
              value={t('{{count}} steps', { count: run.cacheHits })}
            />
            <Metric label={t('Tokens')} value={formatTokens(run.totalTokens)} />
            <Metric
              label={t('Duration')}
              value={formatUseTime(run.durationMs / 1000)}
            />
            {run.estimateQuota > 0 && (
              <Metric
                label={t('Estimated cost')}
                value={formatLogQuota(run.estimateQuota)}
              />
            )}
            {run.budgetCap > 0 && (
              <Metric
                label={t('Run budget cap')}
                value={formatLogQuota(run.budgetCap)}
              />
            )}
          </div>

          <div className='flex flex-wrap gap-2'>
            <Button
              disabled={run.status === 'running'}
              onClick={props.onRestore}
              size='sm'
              type='button'
              variant='outline'
            >
              <RotateCcw aria-hidden='true' />
              {t('Reuse this run')}
            </Button>
            <Button
              disabled={run.status === 'running'}
              onClick={props.onRerun}
              size='sm'
              type='button'
            >
              <Zap aria-hidden='true' />
              {t('Rerun with fresh outputs')}
            </Button>
            <Button
              disabled={run.status === 'running'}
              onClick={props.onDelete}
              size='sm'
              type='button'
              variant='outline'
            >
              <Trash2 aria-hidden='true' />
              {t('Delete')}
            </Button>
          </div>

          {props.comparison && (
            <section className='grid gap-2 rounded-lg border p-3'>
              <div className='flex items-center justify-between gap-2'>
                <span className='text-sm font-medium'>
                  {t('Changes in the rerun')}
                </span>
                <span className='text-muted-foreground text-xs'>
                  {t('{{count}} changed steps', {
                    count: changedComparison.length,
                  })}
                </span>
              </div>
              {changedComparison.length === 0 ? (
                <p className='text-muted-foreground text-xs'>
                  {t('No step differences.')}
                </p>
              ) : (
                <div className='grid gap-2'>
                  {changedComparison.map((row) => (
                    <div
                      className='grid gap-1 rounded-md border p-2 text-xs'
                      key={row.nodeId}
                    >
                      <div className='flex min-w-0 items-center justify-between gap-2'>
                        <span className='truncate font-medium'>
                          {row.model || row.nodeId}
                        </span>
                        <span className='text-muted-foreground shrink-0'>
                          {formatLogQuota(row.before?.quota ?? 0)}
                          {' → '}
                          {formatLogQuota(row.after?.quota ?? 0)}
                        </span>
                      </div>
                      <div className='text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5'>
                        {row.reasons.map((reason) => (
                          <span key={reason}>{t(reason)}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className='grid gap-2'>
            <span className='text-sm font-medium'>{t('Step waterfall')}</span>
            {run.nodes.length === 0 ? (
              <p className='text-muted-foreground text-xs'>
                {t('This run did not record any steps.')}
              </p>
            ) : (
              <div className='border-l pl-3'>
                {run.nodes.map((node) => (
                  <WorkflowNodeRow key={node.nodeId} node={node} />
                ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
      {props.children}
    </div>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className='bg-muted/40 grid gap-0.5 rounded-md border px-2 py-1.5'>
      <span className='text-muted-foreground'>{props.label}</span>
      <span className='font-medium'>{props.value}</span>
    </div>
  )
}

function WorkflowNodeRow(props: { node: CanvasWorkflowRunNodeRecord }) {
  const { t } = useTranslation()
  const { node } = props
  return (
    <div className='relative grid gap-1 border-b py-2 last:border-b-0'>
      <span className='bg-border absolute top-4 -left-[17px] size-2 rounded-full' />
      <div className='flex min-w-0 items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='truncate text-sm font-medium'>
            {node.model || node.nodeId}
          </span>
          <Badge variant='outline'>
            {t(node.kind === 'model' ? 'Model call' : 'Generation')}
          </Badge>
          {node.cacheHit && (
            <Badge variant='secondary'>
              <Zap aria-hidden='true' />
              {t('Cached')}
            </Badge>
          )}
        </div>
        <StatusBadge
          copyable={false}
          label={t(NODE_STATUS_LABELS[node.status])}
          size='sm'
          variant={
            node.status === 'succeeded'
              ? 'success'
              : node.status === 'failed'
                ? 'danger'
                : 'neutral'
          }
        />
      </div>
      <div className='text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs'>
        <span>{t('Group: {{group}}', { group: node.group })}</span>
        <span>{formatUseTime(node.durationMs / 1000)}</span>
        {node.totalTokens > 0 && (
          <span>{t('{{count}} tokens', { count: node.totalTokens })}</span>
        )}
        <span>{formatLogQuota(node.quota)}</span>
        {node.resultCount > 0 && (
          <span>{t('{{count}} results', { count: node.resultCount })}</span>
        )}
      </div>
      {node.output && (
        <p className='text-muted-foreground line-clamp-2 text-xs whitespace-pre-wrap'>
          {node.output}
        </p>
      )}
      {node.error && (
        <p className='text-destructive text-xs'>{t(node.error)}</p>
      )}
    </div>
  )
}
