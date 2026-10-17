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
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { FormItem } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  SettingsForm,
  SettingsFormGrid,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

type WalletOverdraftSectionProps = {
  /** Global credit line in USD; 0 means the wallet may not go below zero. */
  defaultUsd: number
  /** JSON object of user group to USD credit line. */
  groupOverridesJson: string
}

type OverrideDraft = { group: string; usd: string }

function parseOverrides(json: string): OverrideDraft[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return []
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'number')
      .map(([group, value]) => ({ group, usd: String(value) }))
      .sort((a, b) => a.group.localeCompare(b.group))
  } catch {
    return []
  }
}

function serializeOverrides(drafts: OverrideDraft[]): string {
  const entries = [...drafts]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((draft) => [draft.group, Number(draft.usd)] as const)
  return JSON.stringify(Object.fromEntries(entries))
}

function isNonNegativeNumber(value: string): boolean {
  if (value === '') return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

export function WalletOverdraftSection(props: WalletOverdraftSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const baselineOverrides = useMemo(
    () => parseOverrides(props.groupOverridesJson),
    [props.groupOverridesJson]
  )
  const [limit, setLimit] = useState<string>(String(props.defaultUsd ?? 0))
  const [overrides, setOverrides] = useState<OverrideDraft[]>(baselineOverrides)
  const [newGroup, setNewGroup] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setLimit(String(props.defaultUsd ?? 0))
    setOverrides(parseOverrides(props.groupOverridesJson))
    setErrors({})
  }, [props.defaultUsd, props.groupOverridesJson])

  const handleAddGroup = () => {
    const group = newGroup.trim()
    if (!group || overrides.some((override) => override.group === group)) {
      setNewGroup('')
      return
    }
    setOverrides((current) => [...current, { group, usd: '0' }])
    setNewGroup('')
  }

  const handleSave = async () => {
    const nextErrors: Record<string, string> = {}
    if (!isNonNegativeNumber(limit)) {
      nextErrors.limit = t('Must be greater than or equal to 0')
    }
    overrides.forEach((override) => {
      if (!isNonNegativeNumber(override.usd)) {
        nextErrors[override.group] = t('Must be greater than or equal to 0')
      }
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const requests: Array<{ key: string; value: string }> = []
    if (Number(limit) !== props.defaultUsd) {
      requests.push({
        key: 'quota_setting.overdraft_limit_usd',
        value: String(Number(limit)),
      })
    }
    const overridesJson = serializeOverrides(overrides)
    if (overridesJson !== serializeOverrides(baselineOverrides)) {
      requests.push({
        key: 'quota_setting.overdraft_group_overrides',
        value: overridesJson,
      })
    }
    if (requests.length === 0) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      for (const request of requests) {
        await updateOption.mutateAsync(request)
      }
    } catch {
      // useUpdateOption already surfaced the failure; keep the draft for retry.
    }
  }

  return (
    <SettingsSection title={t('Wallet Overdraft')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateOption.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save wallet overdraft'
        />

        <div className='space-y-6'>
          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='wallet-overdraft-limit'>
                {t('Wallet overdraft limit (USD)')}
              </Label>
              <Input
                aria-invalid={errors.limit ? true : undefined}
                id='wallet-overdraft-limit'
                inputMode='decimal'
                min={0}
                onChange={(event) => setLimit(event.target.value)}
                step='any'
                type='number'
                value={limit}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'How far the wallet balance may go below zero before the excess is recorded as debt. 0 means the wallet may not go below zero; postpaid user groups can be widened per group.'
                )}
              </p>
              {errors.limit && (
                <p className='text-destructive text-sm'>{errors.limit}</p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Group overrides')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Override the credit line for one user group. A group appears here only when its limit differs from the global default.'
                )}
              </p>
            </div>

            {overrides.map((override, index) => (
              <div
                key={override.group}
                className='flex flex-wrap items-end gap-3 rounded-lg border p-4'
              >
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`wallet-overdraft-group-${override.group}`}>
                    {t('Group')}
                  </Label>
                  <Input
                    disabled
                    id={`wallet-overdraft-group-${override.group}`}
                    value={override.group}
                  />
                </FormItem>
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`wallet-overdraft-usd-${override.group}`}>
                    {t('Credit line (USD)')}
                  </Label>
                  <Input
                    aria-invalid={
                      errors[override.group] === undefined ? undefined : true
                    }
                    id={`wallet-overdraft-usd-${override.group}`}
                    inputMode='decimal'
                    min={0}
                    onChange={(event) =>
                      setOverrides((current) =>
                        current.map((entry, position) =>
                          position === index
                            ? { ...entry, usd: event.target.value }
                            : entry
                        )
                      )
                    }
                    step='any'
                    type='number'
                    value={override.usd}
                  />
                  {errors[override.group] && (
                    <p className='text-destructive text-sm'>
                      {errors[override.group]}
                    </p>
                  )}
                </FormItem>
                <Button
                  aria-label={t('Remove')}
                  onClick={() =>
                    setOverrides((current) =>
                      current.filter((_, position) => position !== index)
                    )
                  }
                  size='icon-sm'
                  type='button'
                  variant='ghost'
                >
                  <Trash2 aria-hidden='true' />
                </Button>
              </div>
            ))}

            <div className='flex flex-wrap items-end gap-3 rounded-lg border border-dashed p-4'>
              <FormItem className='min-w-32 flex-1'>
                <Label htmlFor='wallet-overdraft-new-group'>{t('Group')}</Label>
                <Input
                  id='wallet-overdraft-new-group'
                  onChange={(event) => setNewGroup(event.target.value)}
                  placeholder={t('Enter a group name')}
                  value={newGroup}
                />{' '}
              </FormItem>
              <Button
                onClick={handleAddGroup}
                size='sm'
                type='button'
                variant='outline'
              >
                <Plus aria-hidden='true' className='h-4 w-4' />
                {t('Add group')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
