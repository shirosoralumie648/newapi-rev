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
import { useTranslation } from 'react-i18next'

import { StatusBadge } from '@/components/status-badge'
import { PLAYGROUND_GENERATION_BATCH_STATUS } from '@/features/playground/constants'
import { formatLogQuota, formatUseTime } from '@/lib/format'

import type {
  CanvasGenerationCell,
  CanvasGenerationCellStatus,
} from '../../lib/canvas-generation-run'

const CELL_STATUS_VARIANTS: Record<
  CanvasGenerationCellStatus,
  'neutral' | 'info' | 'success' | 'danger' | 'warning'
> = {
  pending: 'neutral',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'warning',
}

const CELL_STATUS_LABELS: Record<CanvasGenerationCellStatus, string> = {
  pending: PLAYGROUND_GENERATION_BATCH_STATUS.PENDING,
  running: PLAYGROUND_GENERATION_BATCH_STATUS.RUNNING,
  succeeded: PLAYGROUND_GENERATION_BATCH_STATUS.SUCCEEDED,
  failed: PLAYGROUND_GENERATION_BATCH_STATUS.FAILED,
  skipped: PLAYGROUND_GENERATION_BATCH_STATUS.SKIPPED,
}

interface CanvasGenerationResultsProps {
  cells: CanvasGenerationCell[]
}

/**
 * One side-by-side cell per request of a media batch: the model and the
 * parameters actually sent, the elapsed time and pre-run estimate observed for
 * that cell, and the inline images of a synchronous answer. Durable task cells
 * only link their task id; the shared task list carries their artifacts.
 */
export function CanvasGenerationResults(props: CanvasGenerationResultsProps) {
  const { t } = useTranslation()
  if (props.cells.length === 0) return null

  return (
    <section aria-label={t('Generated media')} className='grid gap-2'>
      <ul className='grid list-none gap-2 p-0 sm:grid-cols-2'>
        {props.cells.map((cell) => {
          const request = cell.request
          const params = [
            request.size,
            request.quality,
            request.seed ? t('Seed {{seed}}', { seed: request.seed }) : '',
            request.count ? t('Count {{count}}', { count: request.count }) : '',
            request.duration
              ? t('Duration {{seconds}}s', { seconds: request.duration })
              : '',
          ].filter(Boolean)
          return (
            <li className='min-w-0 rounded-lg border p-2.5' key={request.id}>
              <div className='flex items-center justify-between gap-2'>
                <StatusBadge
                  copyable={false}
                  label={t(CELL_STATUS_LABELS[cell.status])}
                  pulse={cell.status === 'running'}
                  variant={CELL_STATUS_VARIANTS[cell.status]}
                />
                <span
                  className='text-muted-foreground min-w-0 truncate text-xs'
                  title={request.model}
                >
                  {request.model}
                </span>
              </div>
              <p className='text-muted-foreground mt-1 truncate text-xs'>
                {params.join(' · ')}
              </p>
              <div className='text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 text-xs'>
                {cell.elapsedMs !== undefined ? (
                  <span>
                    {t('Elapsed {{time}}', {
                      time: formatUseTime(cell.elapsedMs / 1000),
                    })}
                  </span>
                ) : null}
                {cell.estimatedQuota !== undefined ? (
                  <span>
                    {t('Estimated {{quota}}', {
                      quota: formatLogQuota(cell.estimatedQuota),
                    })}
                  </span>
                ) : null}
                {cell.taskId ? (
                  <span className='truncate'>
                    {t('Task {{id}}', { id: cell.taskId })}
                  </span>
                ) : null}
              </div>
              {cell.error ? (
                <p className='text-destructive mt-1 text-xs break-words'>
                  {cell.error}
                </p>
              ) : null}
              {cell.images && cell.images.length > 0 ? (
                <div className='mt-2 grid gap-2'>
                  {cell.images.map((image, index) => {
                    const source =
                      image.url ??
                      (image.b64Json
                        ? `data:image/png;base64,${image.b64Json}`
                        : '')
                    if (!source) return null
                    return (
                      <a
                        href={source}
                        key={source}
                        rel='noopener noreferrer'
                        target='_blank'
                      >
                        <img
                          alt={`${t('Generated image')} ${index + 1}`}
                          className='border-border/70 max-h-48 w-full rounded-md border object-contain'
                          src={source}
                        />
                      </a>
                    )
                  })}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
