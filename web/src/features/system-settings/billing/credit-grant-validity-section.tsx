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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CREDIT_GRANT_VALIDITY_SOURCES,
  getCreditGrantSourceLabel,
} from '@/features/wallet/lib/credit-grant'

import {
  SettingsForm,
  SettingsFormGrid,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

type CreditGrantValiditySectionProps = {
  /** Global validity in days; 0 keeps granted credit valid forever. */
  defaultDays: number | string
  /** JSON object of grant source to validity in days. */
  sourceExpiryDaysJson: string
}

type SourceDraft = { source: string; days: string }

const MAX_EXPIRY_DAYS = 3650

function parseSourceExpiry(json: string): SourceDraft[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return []
    return CREDIT_GRANT_VALIDITY_SOURCES.filter(
      (source) => source in (parsed as Record<string, unknown>)
    ).map((source) => ({
      source,
      days: String((parsed as Record<string, number>)[source]),
    }))
  } catch {
    return []
  }
}

function serializeSourceExpiry(drafts: SourceDraft[]): string {
  const entries = CREDIT_GRANT_VALIDITY_SOURCES.filter((source) =>
    drafts.some((draft) => draft.source === source)
  ).map((source) => {
    const draft = drafts.find((entry) => entry.source === source)
    return [source, Number(draft?.days ?? 0)] as const
  })
  return JSON.stringify(Object.fromEntries(entries))
}

function isValidityDays(value: string): boolean {
  if (value.trim() === '') return false
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_EXPIRY_DAYS
}

export function CreditGrantValiditySection(
  props: CreditGrantValiditySectionProps
) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const baselineDays = String(props.defaultDays ?? 0)
  const baselineSources = useMemo(
    () => parseSourceExpiry(props.sourceExpiryDaysJson),
    [props.sourceExpiryDaysJson]
  )

  const [defaultDays, setDefaultDays] = useState(baselineDays)
  const [sources, setSources] = useState<SourceDraft[]>(baselineSources)
  const [newSource, setNewSource] = useState<string>('gift')
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setDefaultDays(baselineDays)
    setSources(parseSourceExpiry(props.sourceExpiryDaysJson))
    setErrors({})
  }, [baselineDays, props.sourceExpiryDaysJson])

  const availableSources = CREDIT_GRANT_VALIDITY_SOURCES.filter(
    (source) => !sources.some((draft) => draft.source === source)
  )

  const handleAddSource = () => {
    if (!newSource || availableSources.length === 0) return
    setSources((current) => [...current, { source: newSource, days: '0' }])
    const next = availableSources.find((source) => source !== newSource)
    if (next) setNewSource(next)
  }

  const handleSave = async () => {
    const nextErrors: Record<string, string> = {}
    if (!isValidityDays(defaultDays)) {
      nextErrors.default = t(
        'Expiry must be a whole number of days between 0 and 3650'
      )
    }
    sources.forEach((draft) => {
      if (!isValidityDays(draft.days)) {
        nextErrors[draft.source] = t(
          'Expiry must be a whole number of days between 0 and 3650'
        )
      }
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const requests: Array<{ key: string; value: string }> = []
    if (String(Number(defaultDays)) !== String(Number(baselineDays))) {
      requests.push({
        key: 'credit_grant_setting.default_expiry_days',
        value: String(Number(defaultDays)),
      })
    }
    const sourcesJson = serializeSourceExpiry(sources)
    if (sourcesJson !== serializeSourceExpiry(baselineSources)) {
      requests.push({
        key: 'credit_grant_setting.source_expiry_days',
        value: sourcesJson,
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
    <SettingsSection title={t('Credit grant validity')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateOption.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save credit grant validity'
        />

        <div className='space-y-6'>
          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='credit-grant-default-days'>
                {t('Default validity (days)')}
              </Label>
              <Input
                aria-invalid={errors.default ? true : undefined}
                id='credit-grant-default-days'
                inputMode='numeric'
                min={0}
                onChange={(event) => setDefaultDays(event.target.value)}
                type='number'
                value={defaultDays}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Days before granted credit expires. 0 keeps granted credit valid forever.'
                )}
              </p>
              {errors.default && (
                <p className='text-destructive text-sm'>{errors.default}</p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>
                {t('Per-source validity (days)')}
              </h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Override the validity of one grant source. A source appears here only when its validity differs from the global default.'
                )}
              </p>
            </div>

            {sources.map((draft, index) => (
              <div
                key={draft.source}
                className='flex flex-wrap items-end gap-3 rounded-lg border p-4'
              >
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`credit-grant-source-${draft.source}`}>
                    {t('Grant source')}
                  </Label>
                  <Input
                    disabled
                    id={`credit-grant-source-${draft.source}`}
                    value={t(getCreditGrantSourceLabel(draft.source))}
                  />
                </FormItem>
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`credit-grant-days-${draft.source}`}>
                    {t('Validity (days)')}
                  </Label>
                  <Input
                    aria-invalid={
                      errors[draft.source] === undefined ? undefined : true
                    }
                    id={`credit-grant-days-${draft.source}`}
                    inputMode='numeric'
                    min={0}
                    onChange={(event) =>
                      setSources((current) =>
                        current.map((entry, position) =>
                          position === index
                            ? { ...entry, days: event.target.value }
                            : entry
                        )
                      )
                    }
                    type='number'
                    value={draft.days}
                  />
                  {errors[draft.source] && (
                    <p className='text-destructive text-sm'>
                      {errors[draft.source]}
                    </p>
                  )}
                </FormItem>
                <Button
                  aria-label={t('Remove')}
                  onClick={() =>
                    setSources((current) =>
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
                <Label htmlFor='credit-grant-new-source'>
                  {t('Grant source')}
                </Label>
                <Select
                  items={availableSources.map((source) => ({
                    value: source,
                    label: t(getCreditGrantSourceLabel(source)),
                  }))}
                  value={newSource}
                  onValueChange={(value) => {
                    if (value !== null) setNewSource(value)
                  }}
                >
                  <SelectTrigger
                    id='credit-grant-new-source'
                    className='w-full'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {availableSources.map((source) => (
                        <SelectItem key={source} value={source}>
                          {t(getCreditGrantSourceLabel(source))}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FormItem>
              <Button
                disabled={availableSources.length === 0}
                onClick={handleAddSource}
                size='sm'
                type='button'
                variant='outline'
              >
                <Plus aria-hidden='true' className='h-4 w-4' />
                {t('Add source')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
