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
import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import * as z from 'zod'

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

const drawingSchema = z.object({
  DrawingEnabled: z.boolean(),
  MjNotifyEnabled: z.boolean(),
  MjAccountFilterEnabled: z.boolean(),
  MjForwardUrlEnabled: z.boolean(),
  MjModeClearEnabled: z.boolean(),
  MjActionCheckSuccessEnabled: z.boolean(),
  MjImageAccessMode: z.enum(['auth', 'signed', 'legacy']),
})

type DrawingFormValues = z.infer<typeof drawingSchema>

// MjImageAccessMode is the only non-boolean field, so the switch list only
// renders the boolean toggles of the drawing form.
type DrawingSwitchField = {
  [Key in keyof DrawingFormValues]: DrawingFormValues[Key] extends boolean
    ? Key
    : never
}[keyof DrawingFormValues]

type DrawingSettingsSectionProps = {
  defaultValues: DrawingFormValues
}

export function DrawingSettingsSection({
  defaultValues,
}: DrawingSettingsSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const form = useForm<DrawingFormValues>({
    resolver: zodResolver(drawingSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
  }, [defaultValues, form])

  const onSubmit = async (values: DrawingFormValues) => {
    const updates = Object.entries(values).filter(
      ([key, value]) => value !== defaultValues[key as keyof DrawingFormValues]
    )

    for (const [key, value] of updates) {
      await updateOption.mutateAsync({ key, value })
    }
  }

  const accessMode = form.watch('MjImageAccessMode')
  const accessModeDescriptions: Record<
    DrawingFormValues['MjImageAccessMode'],
    string
  > = {
    auth: t('Login or API token access checks that the caller owns the task.'),
    signed: t('Signed links expire and load without a login.'),
    legacy: t(
      'Legacy mode keeps the previous open access: anyone who knows a task ID can load its image.'
    ),
  }

  const switches: Array<{
    name: DrawingSwitchField
    label: string
    description: string
  }> = [
    {
      name: 'DrawingEnabled',
      label: t('Enable drawing features'),
      description: t(
        'Required to expose MjProxy-style image generation to end users.'
      ),
    },
    {
      name: 'MjNotifyEnabled',
      label: t('Allow upstream callbacks'),
      description: t(
        'When enabled, MjProxy callbacks are accepted (reveals server IP).'
      ),
    },
    {
      name: 'MjAccountFilterEnabled',
      label: t('Allow accountFilter parameter'),
      description: t(
        'Keep enabled if you need to proxy requests for different upstream accounts.'
      ),
    },
    {
      name: 'MjForwardUrlEnabled',
      label: t('Rewrite callback URLs to the local server'),
      description: t(
        'Automatically replaces upstream callback URLs with the server address.'
      ),
    },
    {
      name: 'MjModeClearEnabled',
      label: t('Clear mode flags in prompts'),
      description: t(
        'Removes MjProxy flags such as --fast, --relax, and --turbo from user prompts.'
      ),
    },
    {
      name: 'MjActionCheckSuccessEnabled',
      label: t('Require job success before follow-up actions'),
      description: t(
        'Users must wait for a successful drawing before upscales or variations.'
      ),
    },
  ]

  return (
    <SettingsSection title={t('Drawing')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
            saveLabel='Save drawing settings'
          />
          <div className='space-y-4'>
            <FormField
              control={form.control}
              name='MjImageAccessMode'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Image link access mode')}</FormLabel>
                  <FormControl>
                    <Select
                      items={[
                        {
                          value: 'auth',
                          label: t('Require login or API token'),
                        },
                        { value: 'signed', label: t('Signed expiring link') },
                        { value: 'legacy', label: t('Legacy open access') },
                      ]}
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          <SelectItem value='auth'>
                            {t('Require login or API token')}
                          </SelectItem>
                          <SelectItem value='signed'>
                            {t('Signed expiring link')}
                          </SelectItem>
                          <SelectItem value='legacy'>
                            {t('Legacy open access')}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormDescription>
                    {accessModeDescriptions[accessMode]}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {switches.map((item) => (
              <FormField
                key={item.name}
                control={form.control}
                name={item.name}
                render={({ field }) => (
                  <SettingsSwitchItem>
                    <SettingsSwitchContent>
                      <FormLabel>{item.label}</FormLabel>
                      <FormDescription>{item.description}</FormDescription>
                    </SettingsSwitchContent>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage />
                  </SettingsSwitchItem>
                )}
              />
            ))}
          </div>
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
