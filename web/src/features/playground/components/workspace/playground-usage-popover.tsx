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

import { usePlaygroundStorageBilling, usePlaygroundUsage } from '../../hooks'

function usedPercent(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(100, (used / limit) * 100)
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
  // Every row reports its count against the account limit; rows that also store
  // bytes add the byte line, and a byte-only budget (object storage) drives the
  // progress bar from bytes instead of a count that does not exist.
  const rows = [
    {
      key: 'sessions',
      label: t('Conversations'),
      metric: usage.sessions,
      counts: true,
      bytes: false,
    },
    {
      key: 'memories',
      label: t('Memories'),
      metric: usage.memories,
      counts: true,
      bytes: false,
    },
    {
      key: 'attachments',
      label: t('Attachments'),
      metric: usage.attachments,
      counts: true,
      bytes: true,
    },
    {
      key: 'artifacts',
      label: t('Artifacts'),
      metric: usage.artifacts,
      counts: true,
      bytes: true,
    },
    {
      key: 'canvas',
      label: t('Canvas'),
      metric: usage.canvas,
      counts: true,
      bytes: true,
    },
    {
      key: 'canvas-snapshots',
      label: t('Canvas history'),
      metric: usage.canvasSnapshots,
      counts: true,
      bytes: true,
    },
    {
      key: 'canvas-templates',
      label: t('Canvas templates'),
      metric: usage.canvasTemplates,
      counts: true,
      bytes: true,
    },
    {
      key: 'comparison-runs',
      label: t('Compare runs'),
      metric: usage.comparisonRuns,
      counts: true,
      bytes: true,
    },
    {
      key: 'workflow-runs',
      label: t('Workflow runs'),
      metric: usage.workflowRuns,
      counts: true,
      bytes: true,
    },
    {
      key: 'knowledge-bases',
      label: t('Knowledge bases'),
      metric: usage.knowledgeBases,
      counts: true,
      bytes: false,
    },
    {
      key: 'kb-documents',
      label: t('Knowledge base documents'),
      metric: usage.knowledgeBaseDocuments,
      counts: true,
      bytes: false,
    },
    {
      key: 'kb-chunks',
      label: t('Knowledge base chunks'),
      metric: usage.knowledgeBaseChunks,
      counts: true,
      bytes: true,
    },
    {
      key: 'storage',
      label: t('Object storage'),
      metric: usage.storage,
      counts: false,
      bytes: true,
    },
    {
      key: 'tasks',
      label: t('Tasks'),
      metric: usage.tasks,
      counts: true,
      bytes: true,
    },
  ] as const

  return (
    <div className='flex flex-col gap-3'>
      {usage.group && (
        <div className='flex items-center justify-between gap-3'>
          <span className='font-medium'>{t('Current group')}</span>
          <span className='text-muted-foreground'>{usage.group}</span>
        </div>
      )}
      {rows.map((row) => (
        <div key={row.key} className='flex flex-col gap-1.5'>
          {row.counts && (
            <div className='flex items-center justify-between gap-3'>
              <span className='font-medium'>{row.label}</span>
              <span className='text-muted-foreground tabular-nums'>
                {t('{{used}} of {{limit}}', {
                  used: formatNumber(row.metric.used, locale),
                  limit: formatNumber(row.metric.limit, locale),
                })}
              </span>
            </div>
          )}
          {!row.counts && <span className='font-medium'>{row.label}</span>}
          <Progress
            aria-hidden='true'
            value={
              row.counts
                ? usedPercent(row.metric.used, row.metric.limit)
                : usedPercent(row.metric.usedBytes, row.metric.limitBytes)
            }
          />
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
      <PlaygroundStorageBillingSummary userId={props.userId} />
    </div>
  )
}

/**
 * The optional metered storage tier, rendered only while an administrator has
 * enabled it. The line shows today's accruing peak together with the read-only
 * warning an unpaid settlement raises; a disabled tier or an unavailable
 * status leaves the popover unchanged.
 */
function PlaygroundStorageBillingSummary(props: { userId: number | null }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const query = usePlaygroundStorageBilling(props.userId)

  if (query.isError || !query.data || !query.data.enabled) {
    return null
  }
  const peakBytes = query.data.today?.peakBytes ?? 0
  const egressBytes = query.data.today?.egressBytes ?? 0

  return (
    <div className='flex flex-col gap-1.5 border-t pt-3'>
      <span className='font-medium'>{t('Storage billing')}</span>
      <div className='flex items-center justify-between gap-3'>
        <span className='text-muted-foreground text-xs'>
          {t('Peak stored today')}
        </span>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {formatBytes(peakBytes, locale)}
        </span>
      </div>
      {egressBytes > 0 && (
        <div className='flex items-center justify-between gap-3'>
          <span className='text-muted-foreground text-xs'>
            {t('Downloaded today')}
          </span>
          <span className='text-muted-foreground text-xs tabular-nums'>
            {formatBytes(egressBytes, locale)}
          </span>
        </div>
      )}
      {query.data.readOnly && (
        <p className='text-destructive text-xs'>
          {t(
            'Your wallet has an unpaid balance, so uploading new Playground data is read-only until you top up.'
          )}
        </p>
      )}
    </div>
  )
}

export function PlaygroundUsagePopover(props: {
  userId: number | null
  onOpenUpgrade?: () => void
}) {
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
        {props.onOpenUpgrade && (
          <div className='flex flex-col gap-2 border-t pt-3'>
            <p className='text-muted-foreground text-xs'>
              {t('Subscribe to a plan to get more storage.')}
            </p>
            <Button
              onClick={props.onOpenUpgrade}
              size='sm'
              type='button'
              variant='outline'
            >
              {t('Upgrade for more storage')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
