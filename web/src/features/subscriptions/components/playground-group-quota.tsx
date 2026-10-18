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
import { HardDrive } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { useSystemOptions } from '@/features/system-settings/hooks/use-system-options'
import { useUpdateOption } from '@/features/system-settings/hooks/use-update-option'
import { PlaygroundQuotaFieldInputs } from '@/features/system-settings/playground/quota-field-inputs'
import {
  buildPlaygroundQuotaDraft,
  buildPlaygroundQuotaOverrideDrafts,
  isPositiveQuotaValue,
  parsePlaygroundQuotaOverrides,
  PLAYGROUND_STORAGE_QUOTA_FIELD_KEYS,
  serializePlaygroundQuotaOverrideDrafts,
  type PlaygroundQuotaDraftErrors,
  type PlaygroundQuotaFieldKey,
} from '@/features/system-settings/playground/quota-fields'

// The option the Playground settings page also writes, so a plan and the
// settings page always read and edit the same group overrides.
const GROUP_OVERRIDES_OPTION_KEY = 'playground_setting.group_overrides'

interface Props {
  group: string
  onConfigure?: () => void
}

/**
 * Edits the Playground storage budgets of the group a subscription plan
 * upgrades its buyers into. The bytes a plan sells are the group override the
 * Playground quota policy resolves, so the plan editor exposes exactly those
 * fields instead of asking the operator to remember a group name on another
 * page. Only the storage fields are shown; every other override of the group
 * is preserved on save.
 */
export function PlaygroundGroupQuotaEditor(props: Props) {
  const { t } = useTranslation()
  const optionsQuery = useSystemOptions()
  const updateOption = useUpdateOption()

  const overridesJson = useMemo(() => {
    const option = optionsQuery.data?.data?.find(
      (candidate) => candidate.key === GROUP_OVERRIDES_OPTION_KEY
    )
    return option?.value ?? '{}'
  }, [optionsQuery.data])
  const baselineOverrides = useMemo(
    () => parsePlaygroundQuotaOverrides(overridesJson),
    [overridesJson]
  )

  const [draft, setDraft] = useState(() => buildPlaygroundQuotaDraft({}))
  const [errors, setErrors] = useState<PlaygroundQuotaDraftErrors>({})

  useEffect(() => {
    const override = baselineOverrides.find(
      (candidate) => candidate.group === props.group
    )
    setDraft(buildPlaygroundQuotaDraft(override?.values ?? {}))
    setErrors({})
  }, [baselineOverrides, props.group])

  const handleChange = (key: PlaygroundQuotaFieldKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const handleSave = async () => {
    const nextErrors: PlaygroundQuotaDraftErrors = {}
    let hasError = false
    for (const key of PLAYGROUND_STORAGE_QUOTA_FIELD_KEYS) {
      const raw = draft[key]
      if (raw !== '' && !isPositiveQuotaValue(raw)) {
        nextErrors[key] = t('Enter a positive whole number.')
        hasError = true
      }
    }
    setErrors(nextErrors)
    if (hasError) return

    const baselineDrafts = buildPlaygroundQuotaOverrideDrafts(baselineOverrides)
    const merged = baselineDrafts.filter(
      (override) => override.group !== props.group
    )
    merged.push({ group: props.group, values: draft })
    const value = serializePlaygroundQuotaOverrideDrafts(merged)
    if (value === serializePlaygroundQuotaOverrideDrafts(baselineDrafts)) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      await updateOption.mutateAsync({
        key: GROUP_OVERRIDES_OPTION_KEY,
        value,
      })
    } catch {
      // useUpdateOption already surfaced the failure; keep the draft for retry.
    }
  }

  return (
    <div className='space-y-3 rounded-lg border p-4'>
      <div className='space-y-1'>
        <h3 className='flex items-center gap-2 text-sm font-medium'>
          <IconBadge tone='info' size='xs'>
            <HardDrive />
          </IconBadge>
          {t('Playground storage quota')}
        </h3>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Users who purchase this plan join {{group}}. These Playground storage limits apply to that group; leave a field empty to inherit the global default.',
            { group: props.group }
          )}
        </p>
      </div>

      {optionsQuery.isPending ? (
        <p className='text-muted-foreground text-sm'>{t('Loading')}</p>
      ) : optionsQuery.isError ? (
        <p className='text-muted-foreground text-sm'>
          {t('Playground resource quotas could not be loaded.')}
        </p>
      ) : (
        <>
          <PlaygroundQuotaFieldInputs
            errors={errors}
            fieldKeys={PLAYGROUND_STORAGE_QUOTA_FIELD_KEYS}
            idPrefix={`playground-plan-quota-${props.group}`}
            onChange={handleChange}
            values={draft}
          />
          <Button
            disabled={updateOption.isPending}
            onClick={() => void handleSave()}
            size='sm'
            type='button'
            variant='outline'
          >
            {updateOption.isPending ? t('Saving...') : t('Save storage quota')}
          </Button>
        </>
      )}

      {props.onConfigure && (
        <Button
          onClick={props.onConfigure}
          size='sm'
          type='button'
          variant='ghost'
        >
          {t('Open Playground resource quotas')}
        </Button>
      )}
    </div>
  )
}
