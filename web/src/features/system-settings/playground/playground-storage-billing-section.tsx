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
import { Plus, ScrollText, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { FormItem } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  SettingsForm,
  SettingsFormGrid,
  SettingsSwitchField,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import { PlaygroundStorageLedgerDialog } from './playground-storage-ledger-dialog'

type StorageEgressMode = 'unmetered' | 'metered'

type StorageBillingDraft = {
  enabled: boolean
  priceUSDPerGBMonth: string
  freeGB: string
  applyGroupRatio: boolean
  graceDays: string
  egressMode: StorageEgressMode
  egressPriceUSDPerGB: string
  egressDailyBytesLimit: string
  egressDailyRequestsLimit: string
}

type GroupFreeDraft = { group: string; freeGB: string }

// Mirrors the server defaults in setting/playground_setting, so a section that
// has never been saved shows the values the gateway would actually use.
const STORAGE_BILLING_DEFAULTS: StorageBillingDraft = {
  enabled: false,
  priceUSDPerGBMonth: '0.015',
  freeGB: '1',
  applyGroupRatio: false,
  graceDays: '7',
  egressMode: 'unmetered',
  egressPriceUSDPerGB: '0',
  egressDailyBytesLimit: '0',
  egressDailyRequestsLimit: '0',
}

function readNumber(value: unknown, fallback: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : String(fallback)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStorageBilling(json: string): {
  draft: StorageBillingDraft
  groupFree: GroupFreeDraft[]
} {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(json || '{}')
    if (isRecord(value)) parsed = value
  } catch {
    parsed = {}
  }
  const egress = isRecord(parsed.egress) ? parsed.egress : {}
  const groupFree: GroupFreeDraft[] = []
  if (isRecord(parsed.group_free_gb)) {
    for (const [group, value] of Object.entries(parsed.group_free_gb)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        groupFree.push({ group, freeGB: String(value) })
      }
    }
    groupFree.sort((a, b) => a.group.localeCompare(b.group))
  }
  return {
    draft: {
      enabled: parsed.enabled === true,
      priceUSDPerGBMonth: readNumber(
        parsed.price_usd_per_gb_month,
        Number(STORAGE_BILLING_DEFAULTS.priceUSDPerGBMonth)
      ),
      freeGB: readNumber(
        parsed.free_gb,
        Number(STORAGE_BILLING_DEFAULTS.freeGB)
      ),
      applyGroupRatio: parsed.apply_group_ratio === true,
      graceDays: readNumber(
        parsed.grace_days,
        Number(STORAGE_BILLING_DEFAULTS.graceDays)
      ),
      egressMode: egress.mode === 'metered' ? 'metered' : 'unmetered',
      egressPriceUSDPerGB: readNumber(egress.price_usd_per_gb, 0),
      egressDailyBytesLimit: readNumber(egress.daily_bytes_limit, 0),
      egressDailyRequestsLimit: readNumber(egress.daily_requests_limit, 0),
    },
    groupFree,
  }
}

function serializeStorageBilling(
  draft: StorageBillingDraft,
  groupFree: GroupFreeDraft[]
): string {
  const entries = [...groupFree]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((entry) => [entry.group, Number(entry.freeGB)] as const)
  return JSON.stringify({
    enabled: draft.enabled,
    price_usd_per_gb_month: Number(draft.priceUSDPerGBMonth),
    free_gb: Number(draft.freeGB),
    group_free_gb: Object.fromEntries(entries),
    apply_group_ratio: draft.applyGroupRatio,
    grace_days: Number(draft.graceDays),
    egress: {
      mode: draft.egressMode,
      price_usd_per_gb: Number(draft.egressPriceUSDPerGB),
      daily_bytes_limit: Number(draft.egressDailyBytesLimit),
      daily_requests_limit: Number(draft.egressDailyRequestsLimit),
    },
  })
}

function isNonNegativeNumber(value: string): boolean {
  if (value === '') return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

function isNonNegativeInteger(value: string): boolean {
  if (value === '') return false
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0
}

export function PlaygroundStorageBillingSection(props: {
  storageBillingJson: string
}) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const baseline = useMemo(
    () => parseStorageBilling(props.storageBillingJson),
    [props.storageBillingJson]
  )
  const baselineJson = useMemo(
    () => serializeStorageBilling(baseline.draft, baseline.groupFree),
    [baseline]
  )

  const [draft, setDraft] = useState<StorageBillingDraft>(() => baseline.draft)
  const [groupFree, setGroupFree] = useState<GroupFreeDraft[]>(
    () => baseline.groupFree
  )
  const [newGroup, setNewGroup] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [ledgerOpen, setLedgerOpen] = useState(false)

  useEffect(() => {
    const next = parseStorageBilling(props.storageBillingJson)
    setDraft(next.draft)
    setGroupFree(next.groupFree)
    setErrors({})
  }, [props.storageBillingJson])

  const handleAddGroup = () => {
    const group = newGroup.trim()
    if (!group || groupFree.some((entry) => entry.group === group)) {
      setNewGroup('')
      return
    }
    setGroupFree((current) => [...current, { group, freeGB: '0' }])
    setNewGroup('')
  }

  const handleSave = async () => {
    const nextErrors: Record<string, string> = {}
    const decimalFields: Array<[string, string]> = [
      ['price', draft.priceUSDPerGBMonth],
      ['free', draft.freeGB],
      ['egressPrice', draft.egressPriceUSDPerGB],
    ]
    const integerFields: Array<[string, string]> = [
      ['grace', draft.graceDays],
      ['egressBytes', draft.egressDailyBytesLimit],
      ['egressRequests', draft.egressDailyRequestsLimit],
    ]
    for (const [field, value] of decimalFields) {
      if (!isNonNegativeNumber(value)) {
        nextErrors[field] = t('Must be greater than or equal to 0')
      }
    }
    for (const [field, value] of integerFields) {
      if (!isNonNegativeInteger(value)) {
        nextErrors[field] = t('Enter a non-negative whole number.')
      }
    }
    groupFree.forEach((entry) => {
      if (!isNonNegativeNumber(entry.freeGB)) {
        nextErrors[`group-${entry.group}`] = t(
          'Must be greater than or equal to 0'
        )
      }
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const serialized = serializeStorageBilling(draft, groupFree)
    if (serialized === baselineJson) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      await updateOption.mutateAsync({
        key: 'playground_setting.storage_billing',
        value: serialized,
      })
    } catch {
      // useUpdateOption already surfaced the failure; keep the draft for retry.
    }
  }

  const egressModeItems = [
    { value: 'unmetered', label: t('Unmetered') },
    { value: 'metered', label: t('Metered') },
  ]

  return (
    <SettingsSection title={t('Playground Storage Billing')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateOption.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save storage billing'
        />

        <div className='space-y-6'>
          <SettingsSwitchField
            controlId='playground-storage-billing-enabled'
            checked={draft.enabled}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, enabled: checked }))
            }
            label={t('Enable metered storage billing')}
            description={t(
              'Charge each account the peak bytes it stores per day and record the daily charge in the wallet ledger. Disabled by default.'
            )}
          />

          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='playground-storage-price'>
                {t('Storage price per GB-month (USD)')}
              </Label>
              <Input
                aria-invalid={errors.price ? true : undefined}
                id='playground-storage-price'
                inputMode='decimal'
                min={0}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    priceUSDPerGBMonth: event.target.value,
                  }))
                }
                step='any'
                type='number'
                value={draft.priceUSDPerGBMonth}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'One GB-day costs one thirtieth of this monthly price. Stored bytes are charged from the wallet, never silently deleted.'
                )}
              </p>
              {errors.price && (
                <p className='text-destructive text-sm'>{errors.price}</p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='playground-storage-free'>
                {t('Free allowance per account (GB)')}
              </Label>
              <Input
                aria-invalid={errors.free ? true : undefined}
                id='playground-storage-free'
                inputMode='decimal'
                min={0}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    freeGB: event.target.value,
                  }))
                }
                step='any'
                type='number'
                value={draft.freeGB}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Stored bytes up to this allowance are free; only the part above it is billed.'
                )}
              </p>
              {errors.free && (
                <p className='text-destructive text-sm'>{errors.free}</p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='playground-storage-grace'>
                {t('Grace period (days)')}
              </Label>
              <Input
                aria-invalid={errors.grace ? true : undefined}
                id='playground-storage-grace'
                inputMode='numeric'
                min={0}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    graceDays: event.target.value,
                  }))
                }
                type='number'
                value={draft.graceDays}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'A day whose charge the wallet cannot cover becomes wallet debt and the account becomes read-only; it recovers automatically after a top-up. Stored data is never deleted.'
                )}
              </p>
              {errors.grace && (
                <p className='text-destructive text-sm'>{errors.grace}</p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <SettingsSwitchField
            controlId='playground-storage-group-ratio'
            checked={draft.applyGroupRatio}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, applyGroupRatio: checked }))
            }
            label={t('Apply the user group ratio')}
            description={t(
              'Multiply storage and egress charges by the account group ratio, the same ratio the relay uses for model prices.'
            )}
          />

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>
                {t('Group free storage overrides')}
              </h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Give one user group a different free allowance. A group without an entry uses the global allowance.'
                )}
              </p>
            </div>

            {groupFree.map((entry, index) => (
              <div
                key={entry.group}
                className='flex flex-wrap items-end gap-3 rounded-lg border p-4'
              >
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`playground-storage-group-${entry.group}`}>
                    {t('Group')}
                  </Label>
                  <Input
                    disabled
                    id={`playground-storage-group-${entry.group}`}
                    value={entry.group}
                  />
                </FormItem>
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`playground-storage-free-${entry.group}`}>
                    {t('Free allowance (GB)')}
                  </Label>
                  <Input
                    aria-invalid={
                      errors[`group-${entry.group}`] === undefined
                        ? undefined
                        : true
                    }
                    id={`playground-storage-free-${entry.group}`}
                    inputMode='decimal'
                    min={0}
                    onChange={(event) =>
                      setGroupFree((current) =>
                        current.map((item, position) =>
                          position === index
                            ? { ...item, freeGB: event.target.value }
                            : item
                        )
                      )
                    }
                    step='any'
                    type='number'
                    value={entry.freeGB}
                  />
                  {errors[`group-${entry.group}`] && (
                    <p className='text-destructive text-sm'>
                      {errors[`group-${entry.group}`]}
                    </p>
                  )}
                </FormItem>
                <Button
                  aria-label={t('Remove')}
                  onClick={() =>
                    setGroupFree((current) =>
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
                <Label htmlFor='playground-storage-new-group'>
                  {t('Group')}
                </Label>
                <Input
                  id='playground-storage-new-group'
                  onChange={(event) => setNewGroup(event.target.value)}
                  placeholder={t('Enter a group name')}
                  value={newGroup}
                />
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

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Egress')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Count the bytes users download from Playground storage. A metered price bills them with the daily settlement; the daily limits refuse the transfer that would cross them.'
                )}
              </p>
            </div>
            <SettingsFormGrid>
              <FormItem>
                <Label htmlFor='playground-storage-egress-mode'>
                  {t('Egress mode')}
                </Label>
                <Select
                  items={egressModeItems}
                  value={draft.egressMode}
                  onValueChange={(value) => {
                    if (value !== 'unmetered' && value !== 'metered') return
                    setDraft((current) => ({
                      ...current,
                      egressMode: value,
                    }))
                  }}
                >
                  <SelectTrigger
                    id='playground-storage-egress-mode'
                    className='w-full'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {egressModeItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <p className='text-muted-foreground text-sm'>
                  {t(
                    'Unmetered still enforces the daily limits; metered also charges the downloaded GBs.'
                  )}
                </p>
              </FormItem>
              <FormItem>
                <Label htmlFor='playground-storage-egress-price'>
                  {t('Egress price per GB (USD)')}
                </Label>
                <Input
                  aria-invalid={errors.egressPrice ? true : undefined}
                  disabled={draft.egressMode !== 'metered'}
                  id='playground-storage-egress-price'
                  inputMode='decimal'
                  min={0}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      egressPriceUSDPerGB: event.target.value,
                    }))
                  }
                  step='any'
                  type='number'
                  value={draft.egressPriceUSDPerGB}
                />
                <p className='text-muted-foreground text-sm'>
                  {t('Charged per downloaded GB when egress is metered.')}
                </p>
                {errors.egressPrice && (
                  <p className='text-destructive text-sm'>
                    {errors.egressPrice}
                  </p>
                )}
              </FormItem>
              <FormItem>
                <Label htmlFor='playground-storage-egress-bytes'>
                  {t('Daily download limit (bytes)')}
                </Label>
                <Input
                  aria-invalid={errors.egressBytes ? true : undefined}
                  id='playground-storage-egress-bytes'
                  inputMode='numeric'
                  min={0}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      egressDailyBytesLimit: event.target.value,
                    }))
                  }
                  type='number'
                  value={draft.egressDailyBytesLimit}
                />
                <p className='text-muted-foreground text-sm'>
                  {t('0 means unlimited.')}
                </p>
                {errors.egressBytes && (
                  <p className='text-destructive text-sm'>
                    {errors.egressBytes}
                  </p>
                )}
              </FormItem>
              <FormItem>
                <Label htmlFor='playground-storage-egress-requests'>
                  {t('Daily download request limit')}
                </Label>
                <Input
                  aria-invalid={errors.egressRequests ? true : undefined}
                  id='playground-storage-egress-requests'
                  inputMode='numeric'
                  min={0}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      egressDailyRequestsLimit: event.target.value,
                    }))
                  }
                  type='number'
                  value={draft.egressDailyRequestsLimit}
                />
                <p className='text-muted-foreground text-sm'>
                  {t('0 means unlimited.')}
                </p>
                {errors.egressRequests && (
                  <p className='text-destructive text-sm'>
                    {errors.egressRequests}
                  </p>
                )}
              </FormItem>
            </SettingsFormGrid>
          </div>

          <div className='flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Storage ledger')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Review, export and reconcile the daily storage charges the gateway recorded.'
                )}
              </p>
            </div>
            <Button
              onClick={() => setLedgerOpen(true)}
              size='sm'
              type='button'
              variant='outline'
            >
              <ScrollText aria-hidden='true' className='h-4 w-4' />
              {t('Open storage ledger')}
            </Button>
          </div>
        </div>
      </SettingsForm>
      <PlaygroundStorageLedgerDialog
        open={ledgerOpen}
        onOpenChange={setLedgerOpen}
      />
    </SettingsSection>
  )
}
