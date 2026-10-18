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
import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { Input } from '@/components/ui/input'
import { useSystemOptions } from '@/features/system-settings/hooks/use-system-options'
import { useUpdateOption } from '@/features/system-settings/hooks/use-update-option'
import { formatPercent } from '@/lib/format'

import { parseReferralAgentTiersOption } from '../lib'
import type { ReferralAgentTier } from '../types'

const AGENT_TIERS_OPTION_KEY = 'referral_setting.agent_tiers'

interface TierDraft {
  id: string
  name: string
  rate: string
}

/**
 * The optional agent tier catalogue: administrators define identifier, name and
 * commission percent per tier. A tier only scales the marked account's own
 * commission; it never introduces uplines or downlines.
 */
export function ReferralAgentTiersCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const optionsQuery = useSystemOptions()
  const updateOption = useUpdateOption()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<TierDraft[]>([])
  const [error, setError] = useState<string | null>(null)

  const tiers = useMemo(() => {
    const option = optionsQuery.data?.data?.find(
      (candidate) => candidate.key === AGENT_TIERS_OPTION_KEY
    )
    return parseReferralAgentTiersOption(option?.value ?? '[]')
  }, [optionsQuery.data])

  const startEditing = () => {
    setDrafts(
      tiers.map((tier) => ({
        id: tier.id,
        name: tier.name,
        rate: String(tier.rate_percent),
      }))
    )
    setError(null)
    setEditing(true)
  }

  const stopEditing = () => {
    setEditing(false)
    setError(null)
  }

  const updateDraft = (index: number, patch: Partial<TierDraft>) => {
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft))
    )
  }

  const addDraft = () => {
    setDrafts((current) => [...current, { id: '', name: '', rate: '' }])
  }

  const removeDraft = (index: number) => {
    setDrafts((current) => current.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    const nextTiers: ReferralAgentTier[] = []
    const seenIds = new Set<string>()
    for (const draft of drafts) {
      const id = draft.id.trim()
      const name = draft.name.trim()
      const rate = Number(draft.rate.trim())
      if (id === '' || name === '') {
        setError(t('Tier identifier and name are required.'))
        return
      }
      if (seenIds.has(id)) {
        setError(t('Tier identifiers must be unique.'))
        return
      }
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        setError(t('Tier commission rates must be numbers between 0 and 100.'))
        return
      }
      seenIds.add(id)
      nextTiers.push({ id, name, rate_percent: rate })
    }
    setError(null)
    try {
      await updateOption.mutateAsync({
        key: AGENT_TIERS_OPTION_KEY,
        value: JSON.stringify(nextTiers),
      })
      void queryClient.invalidateQueries({ queryKey: ['referral-agent'] })
      setEditing(false)
    } catch {
      // useUpdateOption already surfaced the failure; keep the draft for retry.
    }
  }

  return (
    <div className='rounded-lg border'>
      <div className='flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5'>
        <div className='flex items-center gap-2.5'>
          <IconBadge tone='chart-4' size='stat'>
            <Pencil aria-hidden='true' />
          </IconBadge>
          <div>
            <div className='text-sm font-medium'>
              {t('Referral agent tiers')}
            </div>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Define the optional tiers administrators can attach to accounts; a tier only scales that account’s own commission.'
              )}
            </p>
          </div>
        </div>
        {editing ? (
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={stopEditing}
              disabled={updateOption.isPending}
            >
              {t('Discard')}
            </Button>
            <Button
              size='sm'
              onClick={handleSave}
              disabled={updateOption.isPending}
            >
              {t('Save tiers')}
            </Button>
          </div>
        ) : (
          <Button variant='outline' size='sm' onClick={startEditing}>
            <Pencil aria-hidden='true' />
            {t('Edit tiers')}
          </Button>
        )}
      </div>
      <div className='flex flex-col gap-2 px-4 py-3 sm:px-5'>
        {error ? (
          <p role='alert' className='text-destructive text-xs'>
            {error}
          </p>
        ) : null}
        {editing ? (
          <>
            {drafts.map((draft, index) => (
              <div key={index} className='flex flex-wrap items-center gap-2'>
                <Input
                  value={draft.id}
                  onChange={(event) =>
                    updateDraft(index, { id: event.target.value })
                  }
                  placeholder={t('Tier identifier')}
                  aria-label={t('Tier identifier')}
                  className='h-8 w-full sm:w-40'
                />
                <Input
                  value={draft.name}
                  onChange={(event) =>
                    updateDraft(index, { name: event.target.value })
                  }
                  placeholder={t('Tier name')}
                  aria-label={t('Tier name')}
                  className='h-8 w-full sm:w-48'
                />
                <Input
                  value={draft.rate}
                  onChange={(event) =>
                    updateDraft(index, { rate: event.target.value })
                  }
                  inputMode='decimal'
                  placeholder={t('Commission rate (%)')}
                  aria-label={`${t('Commission rate (%)')} ${draft.name || draft.id || index + 1}`}
                  className='h-8 w-full sm:w-40'
                />
                <Button
                  variant='ghost'
                  size='icon-sm'
                  onClick={() => removeDraft(index)}
                  aria-label={`${t('Remove tier')} ${draft.name || draft.id || index + 1}`}
                >
                  <Trash2 aria-hidden='true' />
                </Button>
              </div>
            ))}
            <div>
              <Button variant='outline' size='sm' onClick={addDraft}>
                <Plus aria-hidden='true' />
                {t('Add tier')}
              </Button>
            </div>
          </>
        ) : tiers.length === 0 ? (
          <EmptyState
            icon={Pencil}
            title={t('No agent tiers configured')}
            description={t(
              'Agent tiers are optional; accounts can also be marked without a tier.'
            )}
            className='min-h-[120px]'
          />
        ) : (
          <ul className='flex flex-col gap-1.5'>
            {tiers.map((tier) => (
              <li
                key={tier.id}
                className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2'
              >
                <div className='flex min-w-0 items-center gap-2'>
                  <span className='truncate text-sm'>{tier.name}</span>
                  <span className='text-muted-foreground font-mono text-xs'>
                    {tier.id}
                  </span>
                </div>
                <span className='font-mono text-sm tabular-nums'>
                  {formatPercent(tier.rate_percent)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
