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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerMessage } from '@/lib/server-error-message'

import { getPlaygroundTrash } from '../../api'
import type { PlaygroundTrashItem } from '../../types'
import { PlaygroundSessionExportMenu } from './playground-session-export-menu'

interface PlaygroundTrashPanelProps {
  /** Restores a trashed conversation into the workspace. */
  onRestoreSession: (sessionId: string) => Promise<void>
  /** Restores a trashed canvas for the canvas views. */
  onRestoreCanvas: (projectId: string) => Promise<void>
}

type LoadStatus = 'loading' | 'ready' | 'error'

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * The account's trash inside the Playground Inspector: trashed conversations
 * and canvases with their purge deadlines, restore actions and the server-side
 * retention window. Entries keep counting against the quotas until they are
 * removed.
 */
export function PlaygroundTrashPanel(props: PlaygroundTrashPanelProps) {
  const { t } = useTranslation()
  const [items, setItems] = useState<PlaygroundTrashItem[]>([])
  const [retentionDays, setRetentionDays] = useState(0)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    setStatus('loading')
    setLoadError(null)
    void getPlaygroundTrash()
      .then((listing) => {
        if (!active) return
        setItems(listing.items)
        setRetentionDays(listing.retentionDays)
        setStatus('ready')
      })
      .catch((error) => {
        if (!active) return
        setLoadError(toError(error))
        setStatus('error')
      })
    return () => {
      active = false
    }
  }, [refreshKey])

  const restore = async (item: PlaygroundTrashItem) => {
    setRestoringId(item.id)
    try {
      if (item.kind === 'session') {
        await props.onRestoreSession(item.id)
      } else {
        await props.onRestoreCanvas(item.id)
      }
      setItems((current) =>
        current.filter(
          (entry) => entry.kind !== item.kind || entry.id !== item.id
        )
      )
      toast.success(t('Restored to your workspace'))
    } catch (error) {
      handleServerError(error, t('Unable to restore the item from the trash.'))
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='border-b px-3 py-2 text-xs font-medium'>{t('Trash')}</div>

      {status === 'error' && (
        <div className='shrink-0 p-2'>
          <ErrorState
            className='min-h-0 p-2'
            description={getServerMessage(loadError)}
            onRetry={() => setRefreshKey((value) => value + 1)}
            title={t('Unable to load the trash.')}
          />
        </div>
      )}

      {status === 'loading' && <LoadingState className='min-h-0 flex-1' />}

      {status === 'ready' && items.length === 0 && (
        <div className='flex min-h-0 flex-1 items-center justify-center p-4'>
          <EmptyState
            description={t(
              'Deleted conversations and canvases appear here until the retention period ends.'
            )}
            title={t('The trash is empty')}
          />
        </div>
      )}

      {status === 'ready' && items.length > 0 && (
        <>
          <p className='text-muted-foreground shrink-0 border-b px-3 py-2 text-xs'>
            {t(
              'Trashed items still count toward your storage and are removed after {{days}} days.',
              { days: retentionDays }
            )}
          </p>
          <ScrollArea className='min-h-0 flex-1'>
            <ul className='grid gap-2 p-3'>
              {items.map((item) => (
                <li
                  className='flex min-w-0 items-start gap-2 rounded-md border p-2'
                  key={`${item.kind}:${item.id}`}
                >
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-sm font-medium'>{item.title}</p>
                    <p className='text-muted-foreground text-xs'>
                      {item.kind === 'session'
                        ? t('Conversation')
                        : t('Canvas')}
                    </p>
                    <p className='text-muted-foreground text-xs'>
                      {t('Deleted {{date}}', {
                        date: formatTimestampToDate(
                          item.deletedAt,
                          'milliseconds'
                        ),
                      })}
                    </p>
                    <p className='text-muted-foreground text-xs'>
                      {t('Removed after {{date}}', {
                        date: formatTimestampToDate(
                          item.purgeAt,
                          'milliseconds'
                        ),
                      })}
                    </p>
                  </div>
                  <div className='flex shrink-0 items-center gap-0.5'>
                    {item.kind === 'session' && (
                      <PlaygroundSessionExportMenu
                        className='text-muted-foreground hover:text-foreground'
                        sessionId={item.id}
                        title={item.title}
                      />
                    )}
                    <Button
                      aria-label={t('Restore {{name}}', { name: item.title })}
                      disabled={restoringId !== null}
                      onClick={() => void restore(item)}
                      size='icon-xs'
                      type='button'
                      variant='ghost'
                    >
                      <RotateCcw aria-hidden='true' />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </>
      )}
    </div>
  )
}
