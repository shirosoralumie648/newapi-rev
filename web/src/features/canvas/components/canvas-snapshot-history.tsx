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
import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { TimestampCell } from '@/components/activity-time-cell'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toIntlLocale } from '@/i18n/languages'
import { formatBytes } from '@/lib/format'
import { getServerMessage } from '@/lib/server-error-message'

import { listCanvasSnapshots } from '../api'
import type { CanvasSnapshotSummary } from '../types'

interface CanvasSnapshotHistoryProps {
  open: boolean
  projectId: string
  onOpenChange: (open: boolean) => void
  onRestore: (snapshotId: string) => Promise<void>
}

type HistoryStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * The stored history of one canvas. The list is metadata only; restoring an
 * entry writes it back as the canvas document through the server, which
 * re-validates the restored document and captures the replaced state as one
 * more entry, so a restore can itself be undone.
 */
export function CanvasSnapshotHistory(props: CanvasSnapshotHistoryProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [snapshots, setSnapshots] = useState<CanvasSnapshotSummary[]>([])
  const [status, setStatus] = useState<HistoryStatus>('idle')
  const [error, setError] = useState<Error | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [snapshotToRestore, setSnapshotToRestore] =
    useState<CanvasSnapshotSummary | null>(null)

  const refresh = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const rows = await listCanvasSnapshots(props.projectId)
      setSnapshots(rows)
      setStatus('ready')
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError : new Error(String(loadError))
      )
      setStatus('error')
    }
  }, [props.projectId])

  useEffect(() => {
    setSnapshotToRestore(null)
    if (!props.open) return
    void refresh()
  }, [props.open, refresh])

  const restore = async (snapshot: CanvasSnapshotSummary) => {
    if (pendingId !== null) return
    setPendingId(snapshot.id)
    try {
      await props.onRestore(snapshot.id)
      setSnapshotToRestore(null)
      toast.success(t('Canvas restored from history.'))
      await refresh()
    } catch (restoreError) {
      toast.error(
        t(
          getServerMessage(restoreError) ??
            'The canvas could not be restored from history.'
        )
      )
    } finally {
      setPendingId(null)
    }
  }

  const loading = status === 'loading'
  const failed = status === 'error'

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Canvas history')}
      description={t('Restore a previously saved version of this canvas.')}
      contentClassName='sm:max-w-lg'
      contentHeight='auto'
      bodyClassName='grid gap-2'
    >
      {loading && snapshots.length === 0 && (
        <LoadingState className='min-h-24' />
      )}
      {failed && (
        <ErrorState
          className='min-h-32'
          title={t('Unable to load canvas history.')}
          description={getServerMessage(error)}
          onRetry={() => void refresh()}
        />
      )}
      {!loading && !failed && snapshots.length === 0 && (
        <EmptyState className='min-h-32' title={t('No version history')} />
      )}

      {snapshots.map((snapshot) => (
        <div
          key={snapshot.id}
          className='flex items-center justify-between gap-3 rounded-lg border p-3'
        >
          <div className='grid min-w-0 gap-0.5'>
            <span className='truncate text-sm font-medium'>
              {t('Version {{revision}}', { revision: snapshot.revision })}
            </span>
            <span className='text-muted-foreground text-xs'>
              {t('Nodes: {{count}}', { count: snapshot.nodeCount })}
              {' · '}
              {t('Edges: {{count}}', { count: snapshot.edgeCount })}
              {' · '}
              {formatBytes(snapshot.byteSize, locale)}
            </span>
            <TimestampCell
              className='text-muted-foreground text-xs'
              justNowLabel={t('Just now')}
              locale={locale}
              timestamp={snapshot.createdAt / 1000}
            />
          </div>
          <Button
            aria-label={t('Restore version {{revision}}', {
              revision: snapshot.revision,
            })}
            disabled={pendingId !== null}
            onClick={() => setSnapshotToRestore(snapshot)}
            size='sm'
            type='button'
            variant='outline'
          >
            {pendingId === snapshot.id ? (
              <Spinner />
            ) : (
              <RotateCcw aria-hidden='true' />
            )}
            {t('Restore')}
          </Button>
        </div>
      ))}

      <ConfirmDialog
        confirmText={t('Restore')}
        desc={t(
          'The current canvas is saved to history, then replaced by this version.'
        )}
        handleConfirm={() => {
          if (snapshotToRestore) void restore(snapshotToRestore)
        }}
        isLoading={pendingId !== null}
        onOpenChange={(open) => {
          if (!open) setSnapshotToRestore(null)
        }}
        open={snapshotToRestore !== null}
        title={t('Restore this version?')}
      />
    </Dialog>
  )
}
