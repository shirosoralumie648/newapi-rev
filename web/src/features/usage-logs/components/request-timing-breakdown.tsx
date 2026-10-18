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
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { RequestTimingBreakdown as RequestTimingBreakdownData } from '../types'

/**
 * Phases in display order. A phase the gateway never reached is omitted
 * instead of being reported as zero.
 */
const TIMING_PHASES = [
  { key: 'auth_ms', label: 'Auth' },
  { key: 'channel_select_ms', label: 'Channel selection' },
  { key: 'upstream_ms', label: 'Upstream first byte' },
  { key: 'first_token_ms', label: 'First token' },
  { key: 'total_ms', label: 'Total' },
] as const

function isDuration(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Milliseconds with the unit switch the timing UI already uses: values below a
 * second stay in ms, longer waits read as seconds.
 */
function formatRequestTimingDuration(value: number, t: TFunction): string {
  if (value < 1000) {
    return t('{{value}}ms', { value: Math.round(value) })
  }
  return t('{{value}}s', { value: (value / 1000).toFixed(2) })
}

/**
 * The server-side phase breakdown of one relay request: authentication,
 * channel selection, the upstream's first byte, the first token and the total,
 * plus the retry count when the request needed one. Shared by the usage-log
 * details and the Playground message metadata.
 */
export function RequestTimingBreakdown(props: {
  timing: RequestTimingBreakdownData
  className?: string
}) {
  const { t } = useTranslation()
  const rows = TIMING_PHASES.flatMap((phase) => {
    const value = props.timing[phase.key]
    if (!isDuration(value)) return []
    return [{ key: phase.key, label: phase.label, value }]
  })
  const retries = props.timing.retries
  const showRetries = isDuration(retries) && retries > 0

  if (rows.length === 0 && !showRetries) {
    return null
  }

  return (
    <div className={cn('flex flex-col gap-0.5 text-xs', props.className)}>
      {rows.map((row) => (
        <div
          className='flex items-baseline justify-between gap-3'
          key={row.key}
        >
          <span className='text-muted-foreground'>{t(row.label)}</span>
          <span className='tabular-nums'>
            {formatRequestTimingDuration(row.value, t)}
          </span>
        </div>
      ))}
      {showRetries && (
        <div className='flex items-baseline justify-between gap-3'>
          <span className='text-muted-foreground'>{t('Retries')}</span>
          <span className='tabular-nums'>{retries}</span>
        </div>
      )}
    </div>
  )
}
