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
import {
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StaticDataTable } from '@/components/data-table'
import type { StaticDataTableColumn } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatNumber, formatTimestampToDate } from '@/lib/format'

import {
  useClearReferralAgentMark,
  useReferralAgents,
  useSetReferralAgentMark,
} from '../hooks'
import { getReferralRateSourceLabelKey } from '../lib'
import type { ReferralAgentItem } from '../types'

const AGENTS_PAGE_SIZE = 20
const INHERIT_TIER_VALUE = 'inherit'

/**
 * The optional agent program management: mark accounts as 推荐官/代理 with a
 * tier and/or a single-account rate override, and clear marks. The program is
 * strictly single level — a mark only scales that account's own commission.
 */
export function ReferralAgentsCard() {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [userId, setUserId] = useState('')
  const [tierId, setTierId] = useState(INHERIT_TIER_VALUE)
  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingClear, setPendingClear] = useState<ReferralAgentItem | null>(
    null
  )
  const query = useReferralAgents(page, AGENTS_PAGE_SIZE, true)
  const mark = useSetReferralAgentMark()
  const clear = useClearReferralAgentMark()

  const agents = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const tiers = query.data?.tiers ?? []
  const totalPages = Math.max(1, Math.ceil(total / AGENTS_PAGE_SIZE))

  const tierItems = [
    {
      value: INHERIT_TIER_VALUE,
      label: t('Inherit tier and group configuration'),
    },
    ...tiers.map((tier) => ({
      value: tier.id,
      label: `${tier.name} (${formatNumber(tier.rate_percent)}%)`,
    })),
  ]

  const handleMark = async () => {
    const parsedUserId = Number(userId.trim())
    if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
      setError(t('Enter a valid user ID.'))
      return
    }
    const rateText = rate.trim()
    let ratePercent: number | undefined
    if (rateText !== '') {
      ratePercent = Number(rateText)
      if (
        !Number.isFinite(ratePercent) ||
        ratePercent < 0 ||
        ratePercent > 100
      ) {
        setError(t('The commission rate must be a number between 0 and 100.'))
        return
      }
    }
    setError(null)
    try {
      await mark.mutateAsync({
        userId: parsedUserId,
        request: {
          tier_id: tierId === INHERIT_TIER_VALUE ? '' : tierId,
          ...(ratePercent === undefined ? {} : { rate_percent: ratePercent }),
          note: note.trim(),
        },
      })
      setUserId('')
      setTierId(INHERIT_TIER_VALUE)
      setRate('')
      setNote('')
      toast.success(t('Referral agent updated'))
    } catch {
      // The mutation already surfaced the failure; keep the draft for retry.
    }
  }

  const handleClear = async () => {
    if (!pendingClear) return
    try {
      await clear.mutateAsync(pendingClear.user_id)
      toast.success(t('Referral agent mark cleared'))
      setPendingClear(null)
    } catch {
      // The mutation already surfaced the failure; keep the dialog for retry.
    }
  }

  const columns: StaticDataTableColumn<ReferralAgentItem>[] = [
    {
      id: 'user',
      header: t('User'),
      cell: (agent) => (
        <div className='flex flex-col'>
          <span className='truncate text-sm'>
            {agent.display_name || agent.username}
          </span>
          <span className='text-muted-foreground font-mono text-xs'>
            {agent.username} · #{agent.user_id}
          </span>
        </div>
      ),
    },
    {
      id: 'group',
      header: t('Group'),
      cell: (agent) => agent.group || '-',
    },
    {
      id: 'tier',
      header: t('Tier'),
      cell: (agent) =>
        agent.tier_name || agent.tier_id || t('Inherit group configuration'),
    },
    {
      id: 'rate',
      header: t('Effective rate'),
      cell: (agent) => (
        <div className='flex flex-col'>
          <span className='font-mono text-sm tabular-nums'>
            {formatNumber(agent.effective_rate_percent)}%
          </span>
          <span className='text-muted-foreground text-xs'>
            {t(getReferralRateSourceLabelKey(agent.rate_source))}
          </span>
        </div>
      ),
    },
    {
      id: 'note',
      header: t('Note'),
      cell: (agent) => (
        <span className='text-muted-foreground text-xs'>
          {agent.note || '-'}
        </span>
      ),
    },
    {
      id: 'updated',
      header: t('Updated At'),
      cell: (agent) => formatTimestampToDate(agent.updated_at),
    },
    {
      id: 'actions',
      header: t('Actions'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (agent) => (
        <Button
          variant='ghost'
          size='icon-sm'
          onClick={() => setPendingClear(agent)}
          aria-label={`${t('Clear mark')} ${agent.username}`}
        >
          <Trash2 aria-hidden='true' />
        </Button>
      ),
    },
  ]

  return (
    <div className='rounded-lg border'>
      <div className='flex items-center gap-2.5 border-b px-4 py-3 sm:px-5'>
        <IconBadge tone='chart-3' size='stat'>
          <ShieldCheck aria-hidden='true' />
        </IconBadge>
        <div>
          <div className='text-sm font-medium'>{t('Referral agents')}</div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Mark accounts as referral agents and attach a tier or a single-account rate override.'
            )}
          </p>
        </div>
      </div>
      <div className='flex flex-col gap-3 px-4 py-3 sm:px-5'>
        <div className='flex flex-wrap items-center gap-2'>
          <Input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            inputMode='numeric'
            placeholder={t('User ID')}
            aria-label={t('User ID')}
            className='h-8 w-full sm:w-28'
          />
          <Select
            items={tierItems}
            value={tierId}
            onValueChange={(value) => {
              if (value === null) return
              setTierId(value)
            }}
          >
            <SelectTrigger
              className='h-8 w-full sm:w-56'
              aria-label={t('Tier')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {tierItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            inputMode='decimal'
            placeholder={t('Rate override (%)')}
            aria-label={t('Rate override (%)')}
            className='h-8 w-full sm:w-32'
          />
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('Note (optional)')}
            aria-label={t('Note (optional)')}
            className='h-8 w-full sm:w-48'
          />
          <Button size='sm' onClick={handleMark} disabled={mark.isPending}>
            <UserPlus aria-hidden='true' />
            {t('Mark agent')}
          </Button>
        </div>
        {error ? (
          <p role='alert' className='text-destructive text-xs'>
            {error}
          </p>
        ) : null}
        {query.isLoading ? (
          <LoadingState className='min-h-[200px]' />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={t('No referral agents yet')}
            description={t(
              'Marked accounts and their effective commission rates will appear here.'
            )}
            className='min-h-[160px]'
          />
        ) : (
          <StaticDataTable<ReferralAgentItem>
            columns={columns}
            data={agents}
            getRowKey={(agent) => agent.user_id}
          />
        )}
        <div className='flex items-center justify-between gap-3'>
          <div className='text-muted-foreground text-xs'>
            {total > 0 && t('{{count}} agents', { count: total })}
          </div>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              aria-label={t('Go to previous page')}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className='h-8 w-8 p-0'
            >
              <ChevronLeft className='h-4 w-4' />
            </Button>
            <span
              className='text-muted-foreground text-sm tabular-nums'
              aria-live='polite'
            >
              {page} / {totalPages}
            </span>
            <Button
              variant='outline'
              size='sm'
              aria-label={t('Go to next page')}
              onClick={() => setPage((current) => current + 1)}
              disabled={page >= totalPages}
              className='h-8 w-8 p-0'
            >
              <ChevronRight className='h-4 w-4' />
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={pendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClear(null)
        }}
        title={t('Clear referral agent mark')}
        desc={t(
          'The account then falls back to its tier, its group configuration or the global default.'
        )}
        confirmText={t('Clear mark')}
        destructive
        isLoading={clear.isPending}
        handleConfirm={handleClear}
      />
    </div>
  )
}
