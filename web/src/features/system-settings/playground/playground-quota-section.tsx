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
  SettingsSwitchField,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import { PlaygroundQuotaFieldInputs } from './quota-field-inputs'
import {
  buildPlaygroundQuotaDraft,
  buildPlaygroundQuotaOverrideDrafts,
  isPositiveQuotaValue,
  parsePlaygroundQuotaOverrides,
  parsePlaygroundQuotaValues,
  PLAYGROUND_QUOTA_FIELD_KEYS,
  serializePlaygroundQuotaOverrideDrafts,
  serializePlaygroundQuotaValues,
  type PlaygroundQuotaDraft,
  type PlaygroundQuotaDraftErrors,
  type PlaygroundQuotaFieldKey,
  type PlaygroundQuotaOverrideDraft,
} from './quota-fields'

type PlaygroundQuotaSectionProps = {
  defaultsJson: string
  groupOverridesJson: string
  sandboxPreviewEnabled: boolean
}

export function PlaygroundQuotaSection(props: PlaygroundQuotaSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const [sandboxPreviewEnabled, setSandboxPreviewEnabled] = useState(
    props.sandboxPreviewEnabled
  )

  const baselineDefaults = useMemo(
    () => parsePlaygroundQuotaValues(props.defaultsJson),
    [props.defaultsJson]
  )
  const baselineOverrides = useMemo(
    () => parsePlaygroundQuotaOverrides(props.groupOverridesJson),
    [props.groupOverridesJson]
  )

  const [defaults, setDefaults] = useState<PlaygroundQuotaDraft>(() =>
    buildPlaygroundQuotaDraft(baselineDefaults)
  )
  const [overrides, setOverrides] = useState<PlaygroundQuotaOverrideDraft[]>(
    () => buildPlaygroundQuotaOverrideDrafts(baselineOverrides)
  )
  const [newGroup, setNewGroup] = useState('')
  const [defaultErrors, setDefaultErrors] =
    useState<PlaygroundQuotaDraftErrors>({})
  const [overrideErrors, setOverrideErrors] = useState<
    Record<number, PlaygroundQuotaDraftErrors>
  >({})

  useEffect(() => {
    setDefaults(buildPlaygroundQuotaDraft(baselineDefaults))
    setOverrides(buildPlaygroundQuotaOverrideDrafts(baselineOverrides))
    setDefaultErrors({})
    setOverrideErrors({})
    setSandboxPreviewEnabled(props.sandboxPreviewEnabled)
  }, [baselineDefaults, baselineOverrides, props.sandboxPreviewEnabled])

  const handleAddGroup = () => {
    const group = newGroup.trim()
    if (!group || overrides.some((override) => override.group === group)) {
      setNewGroup('')
      return
    }
    setOverrides((current) => [
      ...current,
      { group, values: buildPlaygroundQuotaDraft({}) },
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
    const nextDefaultErrors: PlaygroundQuotaDraftErrors = {}
    const nextOverrideErrors: Record<number, PlaygroundQuotaDraftErrors> = {}
    let hasError = false
    for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
      const raw = defaults[key]
      if (raw !== '' && !isPositiveQuotaValue(raw)) {
        nextDefaultErrors[key] = t('Enter a positive whole number.')
        hasError = true
      }
    }
    overrides.forEach((override, index) => {
      for (const key of PLAYGROUND_QUOTA_FIELD_KEYS) {
        const raw = override.values[key]
        if (raw !== '' && !isPositiveQuotaValue(raw)) {
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
    const defaultsValue = serializePlaygroundQuotaValues(defaults)
    if (
      defaultsValue !==
      serializePlaygroundQuotaValues(
        buildPlaygroundQuotaDraft(baselineDefaults)
      )
    ) {
      requests.push({
        key: 'playground_setting.defaults',
        value: defaultsValue,
      })
    }
    const overridesValue = serializePlaygroundQuotaOverrideDrafts(overrides)
    if (
      overridesValue !==
      serializePlaygroundQuotaOverrideDrafts(
        buildPlaygroundQuotaOverrideDrafts(baselineOverrides)
      )
    ) {
      requests.push({
        key: 'playground_setting.group_overrides',
        value: overridesValue,
      })
    }
    if (sandboxPreviewEnabled !== props.sandboxPreviewEnabled) {
      requests.push({
        key: 'playground_setting.sandbox_preview_enabled',
        value: String(sandboxPreviewEnabled),
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

        <SettingsSwitchField
          checked={sandboxPreviewEnabled}
          controlId='playground-sandbox-preview-enabled'
          description={t(
            'Render HTML and SVG artifact content in an isolated preview that can never access this site.'
          )}
          disabled={updateOption.isPending}
          label={t('Enable sandboxed artifact preview')}
          onCheckedChange={setSandboxPreviewEnabled}
        />

        <div className='space-y-6'>
          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Global defaults')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t('Values are applied to every user group.')}
              </p>
            </div>
            <PlaygroundQuotaFieldInputs
              grouped
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
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Subscription plans grant the limits of their Upgrade Group, so give a paid group a larger storage quota here.'
                )}
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
                <PlaygroundQuotaFieldInputs
                  grouped
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
