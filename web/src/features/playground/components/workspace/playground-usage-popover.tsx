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
import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { toIntlLocale } from '@/i18n/languages'
import { formatBytes, formatNumber } from '@/lib/format'

import type { PlaygroundUsageMetric } from '../../api'
import { usePlaygroundUsage } from '../../hooks'

function usedPercent(metric: PlaygroundUsageMetric): number {
  if (metric.limit <= 0) return 0
  return Math.min(100, (metric.used / metric.limit) * 100)
}

function PlaygroundUsageSummary(props: { userId: number | null }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const query = usePlaygroundUsage(props.userId)

  if (query.isPending) {
    return (
      <p className='text-muted-foreground'>{t('Loading resource usage...')}</p>
    )
  }
  if (query.isError || !query.data) {
    return (
      <p className='text-destructive' role='alert'>
        {t('Resource usage could not be loaded.')}
      </p>
    )
  }

  const usage = query.data
  const rows = [
    {
      key: 'sessions',
      label: t('Conversations'),
      metric: usage.sessions,
      bytes: false,
    },
    {
      key: 'attachments',
      label: t('Attachments'),
      metric: usage.attachments,
      bytes: true,
    },
    {
      key: 'artifacts',
      label: t('Artifacts'),
      metric: usage.artifacts,
      bytes: true,
    },
    {
      key: 'canvas',
      label: t('Canvas'),
      metric: usage.canvas,
      bytes: true,
    },
  ] as const

  return (
    <div className='flex flex-col gap-3'>
      {rows.map((row) => (
        <div key={row.key} className='flex flex-col gap-1.5'>
          <div className='flex items-center justify-between gap-3'>
            <span className='font-medium'>{row.label}</span>
            <span className='text-muted-foreground tabular-nums'>
              {t('{{used}} of {{limit}}', {
                used: formatNumber(row.metric.used, locale),
                limit: formatNumber(row.metric.limit, locale),
              })}
            </span>
          </div>
          <Progress aria-hidden='true' value={usedPercent(row.metric)} />
          {row.bytes && (
            <span className='text-muted-foreground text-xs tabular-nums'>
              {t('{{used}} of {{limit}}', {
                used: formatBytes(row.metric.usedBytes, locale),
                limit: formatBytes(row.metric.limitBytes, locale),
              })}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export function PlaygroundUsagePopover(props: { userId: number | null }) {
  const { t } = useTranslation()

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t('Resource usage')}
            size='sm'
            type='button'
            variant='ghost'
          />
        }
      >
        <Gauge aria-hidden='true' />
        {t('Resource usage')}
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80'>
        <PopoverHeader>
          <PopoverTitle>{t('Resource usage')}</PopoverTitle>
          <PopoverDescription>
            {t(
              'Your resource usage in the Playground. Limits are set by your administrator.'
            )}
          </PopoverDescription>
        </PopoverHeader>
        <PlaygroundUsageSummary userId={props.userId} />
      </PopoverContent>
    </Popover>
  )
}
