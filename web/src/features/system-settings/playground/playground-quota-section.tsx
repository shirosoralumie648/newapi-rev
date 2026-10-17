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
import {
  PLAYGROUND_QUOTA_FIELDS,
  PLAYGROUND_QUOTA_FIELD_KEYS,
  PLAYGROUND_QUOTA_GROUPS,
  parsePlaygroundQuotaOverrides,
  parsePlaygroundQuotaValues,
  type PlaygroundQuotaFieldKey,
  type PlaygroundQuotaValues,
} from './quota-fields'

type PlaygroundQuotaSectionProps = {
  defaultsJson: string
  groupOverridesJson: string
}

type QuotaDraft = Record<PlaygroundQuotaFieldKey, string>
type QuotaDraftErrors = Partial<Record<PlaygroundQuotaFieldKey, string>>
type QuotaOverrideDraft = { group: string; values: QuotaDraft }

function buildDraft(values: PlaygroundQuotaValues): QuotaDraft {
  const draft = {} as QuotaDraft
  for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
    draft[key] = values[key] === undefined ? '' : String(values[key])
  }
  return draft
}

function buildOverrideDrafts(
  overrides: ReturnType<typeof parsePlaygroundQuotaOverrides>
): QuotaOverrideDraft[] {
  return overrides.map((override) => ({
    group: override.group,
    values: buildDraft(override.values),
  }))
}

function serializeDefaults(draft: QuotaDraft): string {
  return JSON.stringify(
    Object.fromEntries(
      PLAYGROUND_QUOTA_FIELD_KEYS.map((key) => [key, Number(draft[key])])
    )
  )
}

function serializeOverrides(overrides: QuotaOverrideDraft[]): string {
  const entries = [...overrides]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((override) => {
      const values = Object.fromEntries(
        PLAYGROUND_QUOTA_FIELD_KEYS.filter(
          (key) => override.values[key] !== ''
        ).map((key) => [key, Number(override.values[key])])
      )
      return [override.group, values] as const
    })
    .filter(([, values]) => Object.keys(values).length > 0)
  return JSON.stringify(Object.fromEntries(entries))
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0
}

type QuotaFieldInputsProps = {
  idPrefix: string
  values: QuotaDraft
  errors: QuotaDraftErrors
  disabled?: boolean
  onChange: (key: PlaygroundQuotaFieldKey, value: string) => void
}

function QuotaFieldInputs(props: QuotaFieldInputsProps) {
  const { t } = useTranslation()

  return (
    <div className='space-y-5'>
      {PLAYGROUND_QUOTA_GROUPS.map((group) => {
        const fields = PLAYGROUND_QUOTA_FIELDS.filter(
          (field) => field.group === group.id
        )
        if (fields.length === 0) return null
        return (
          <div key={group.id} className='space-y-3'>
            <h4 className='text-sm font-medium'>{t(group.labelKey)}</h4>
            <SettingsFormGrid>
              {fields.map((field) => {
                const id = `${props.idPrefix}-${field.key}`
                const error = props.errors[field.key]
                return (
                  <FormItem key={field.key}>
                    <Label htmlFor={id}>
                      {t(field.labelKey)}
                      {field.bytes ? ` (${t('bytes')})` : ''}
                    </Label>
                    <Input
                      aria-invalid={error ? true : undefined}
                      disabled={props.disabled}
                      id={id}
                      inputMode='numeric'
                      min={1}
                      onChange={(event) =>
                        props.onChange(field.key, event.target.value)
                      }
                      type='number'
                      value={props.values[field.key]}
                    />
                    {error && (
                      <p className='text-destructive text-sm'>{error}</p>
                    )}
                  </FormItem>
                )
              })}
            </SettingsFormGrid>
          </div>
        )
      })}
    </div>
  )
}

export function PlaygroundQuotaSection(props: PlaygroundQuotaSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const baselineDefaults = useMemo(
    () => parsePlaygroundQuotaValues(props.defaultsJson),
    [props.defaultsJson]
  )
  const baselineOverrides = useMemo(
    () => parsePlaygroundQuotaOverrides(props.groupOverridesJson),
    [props.groupOverridesJson]
  )

  const [defaults, setDefaults] = useState<QuotaDraft>(() =>
    buildDraft(baselineDefaults)
  )
  const [overrides, setOverrides] = useState<QuotaOverrideDraft[]>(() =>
    buildOverrideDrafts(baselineOverrides)
  )
  const [newGroup, setNewGroup] = useState('')
  const [defaultErrors, setDefaultErrors] = useState<QuotaDraftErrors>({})
  const [overrideErrors, setOverrideErrors] = useState<
    Record<number, QuotaDraftErrors>
  >({})

  useEffect(() => {
    setDefaults(buildDraft(baselineDefaults))
    setOverrides(buildOverrideDrafts(baselineOverrides))
    setDefaultErrors({})
    setOverrideErrors({})
  }, [baselineDefaults, baselineOverrides])

  const handleAddGroup = () => {
    const group = newGroup.trim()
    if (!group || overrides.some((override) => override.group === group)) {
      setNewGroup('')
      return
    }
    setOverrides((current) => [
      ...current,
      { group, values: buildDraft({}) },
    ])
    setNewGroup('')
  }

  const handleOverrideChange = (
    index: number,
    key: PlaygroundQuotaFieldKey,
    value: string
  ) => {
    setOverrides((current) =>
      current.map((override, position) =>
        position === index
          ? { ...override, values: { ...override.values, [key]: value } }
          : override
      )
    )
  }

  const handleSave = async () => {
    const nextDefaultErrors: QuotaDraftErrors = {}
    const nextOverrideErrors: Record<number, QuotaDraftErrors> = {}
    let hasError = false
    for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
      if (!isPositiveInteger(defaults[key])) {
        nextDefaultErrors[key] = t('Enter a positive whole number.')
        hasError = true
      }
    }
    overrides.forEach((override, index) => {
      for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
        const raw = override.values[key]
        if (raw !== '' && !isPositiveInteger(raw)) {
          nextOverrideErrors[index] = {
            ...(nextOverrideErrors[index] ?? {}),
            [key]: t('Enter a positive whole number.'),
          }
          hasError = true
        }
      }
    })
    setDefaultErrors(nextDefaultErrors)
    setOverrideErrors(nextOverrideErrors)
    if (hasError) return

    const requests: Array<{ key: string; value: string }> = []
    const defaultsValue = serializeDefaults(defaults)
    if (defaultsValue !== serializeDefaults(buildDraft(baselineDefaults))) {
      requests.push({
        key: 'playground_setting.defaults',
        value: defaultsValue,
      })
    }
    const overridesValue = serializeOverrides(overrides)
    if (
      overridesValue !==
      serializeOverrides(buildOverrideDrafts(baselineOverrides))
    ) {
      requests.push({
        key: 'playground_setting.group_overrides',
        value: overridesValue,
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
    <SettingsSection title={t('Playground Resource Quotas')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateOption.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save Playground quotas'
        />

        <div className='space-y-6'>
          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Global defaults')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t('Values are applied to every user group.')}
              </p>
            </div>
            <QuotaFieldInputs
              errors={defaultErrors}
              idPrefix='playground-quota-default'
              onChange={(key, value) =>
                setDefaults((current) => ({ ...current, [key]: value }))
              }
              values={defaults}
            />
          </div>

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Group overrides')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t('Leave a field empty to inherit the global default.')}
              </p>
            </div>

            {overrides.map((override, index) => (
              <div
                key={override.group}
                className='space-y-3 rounded-lg border p-4'
              >
                <div className='flex items-center justify-between gap-2'>
                  <span className='font-medium'>{override.group}</span>
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
                <QuotaFieldInputs
                  errors={overrideErrors[index] ?? {}}
                  idPrefix={`playground-quota-override-${override.group}`}
                  onChange={(key, value) =>
                    handleOverrideChange(index, key, value)
                  }
                  values={override.values}
                />
              </div>
            ))}

            <div className='flex flex-wrap items-end gap-2'>
              <FormItem className='min-w-48 flex-1'>
                <Label htmlFor='playground-quota-new-group'>
                  {t('Group name')}
                </Label>
                <Input
                  id='playground-quota-new-group'
                  onChange={(event) => setNewGroup(event.target.value)}
                  placeholder={t('e.g. default')}
                  value={newGroup}
                />
              </FormItem>
              <Button
                disabled={!newGroup.trim()}
                onClick={handleAddGroup}
                type='button'
                variant='outline'
              >
                <Plus aria-hidden='true' />
                {t('Add group override')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
