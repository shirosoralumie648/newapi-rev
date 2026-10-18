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
import { useTranslation } from 'react-i18next'

import { FormItem } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { SettingsFormGrid } from '../components/settings-form-layout'
import {
  PLAYGROUND_QUOTA_FIELDS,
  PLAYGROUND_QUOTA_FIELD_KEYS,
  PLAYGROUND_QUOTA_GROUPS,
  type PlaygroundQuotaDraft,
  type PlaygroundQuotaDraftErrors,
  type PlaygroundQuotaField,
  type PlaygroundQuotaFieldKey,
} from './quota-fields'

const PLAYGROUND_QUOTA_FIELD_BY_KEY = new Map<
  PlaygroundQuotaFieldKey,
  PlaygroundQuotaField
>(PLAYGROUND_QUOTA_FIELDS.map((field) => [field.key, field] as const))

type QuotaFieldInputProps = {
  field: PlaygroundQuotaField
  idPrefix: string
  value: string
  error?: string
  disabled?: boolean
  onChange: (key: PlaygroundQuotaFieldKey, value: string) => void
}

function QuotaFieldInput(props: QuotaFieldInputProps) {
  const { t } = useTranslation()
  const id = `${props.idPrefix}-${props.field.key}`

  return (
    <FormItem>
      <Label htmlFor={id}>
        {t(props.field.labelKey)}
        {props.field.bytes ? ` (${t('bytes')})` : ''}
      </Label>
      <Input
        aria-invalid={props.error ? true : undefined}
        disabled={props.disabled}
        id={id}
        inputMode='numeric'
        min={1}
        onChange={(event) =>
          props.onChange(props.field.key, event.target.value)
        }
        type='number'
        value={props.value}
      />
      {props.error && <p className='text-destructive text-sm'>{props.error}</p>}
    </FormItem>
  )
}

type PlaygroundQuotaFieldInputsProps = {
  idPrefix: string
  values: PlaygroundQuotaDraft
  errors: PlaygroundQuotaDraftErrors
  /** Renders only these fields; defaults to the full policy. */
  fieldKeys?: readonly PlaygroundQuotaFieldKey[]
  /** Groups the fields under their resource headings; a flat grid otherwise. */
  grouped?: boolean
  disabled?: boolean
  onChange: (key: PlaygroundQuotaFieldKey, value: string) => void
}

/**
 * The editable number inputs of a Playground quota policy. The settings page
 * renders every field grouped by resource; the subscription plan editor renders
 * only the storage budgets of one group. Both share the same labels, byte
 * suffix and validation markup.
 */
export function PlaygroundQuotaFieldInputs(
  props: PlaygroundQuotaFieldInputsProps
) {
  const { t } = useTranslation()
  const fieldKeys = props.fieldKeys ?? PLAYGROUND_QUOTA_FIELD_KEYS

  if (!props.grouped) {
    return (
      <SettingsFormGrid>
        {fieldKeys.map((key) => {
          const field = PLAYGROUND_QUOTA_FIELD_BY_KEY.get(key)
          if (!field) return null
          return (
            <QuotaFieldInput
              key={field.key}
              disabled={props.disabled}
              error={props.errors[field.key]}
              field={field}
              idPrefix={props.idPrefix}
              onChange={props.onChange}
              value={props.values[field.key]}
            />
          )
        })}
      </SettingsFormGrid>
    )
  }

  return (
    <div className='space-y-5'>
      {PLAYGROUND_QUOTA_GROUPS.map((group) => {
        const keys = fieldKeys.filter(
          (key) => PLAYGROUND_QUOTA_FIELD_BY_KEY.get(key)?.group === group.id
        )
        if (keys.length === 0) return null
        return (
          <div key={group.id} className='space-y-3'>
            <h4 className='text-sm font-medium'>{t(group.labelKey)}</h4>
            <SettingsFormGrid>
              {keys.map((key) => {
                const field = PLAYGROUND_QUOTA_FIELD_BY_KEY.get(key)
                if (!field) return null
                return (
                  <QuotaFieldInput
                    key={field.key}
                    disabled={props.disabled}
                    error={props.errors[field.key]}
                    field={field}
                    idPrefix={props.idPrefix}
                    onChange={props.onChange}
                    value={props.values[field.key]}
                  />
                )
              })}
            </SettingsFormGrid>
          </div>
        )
      })}
    </div>
  )
}
