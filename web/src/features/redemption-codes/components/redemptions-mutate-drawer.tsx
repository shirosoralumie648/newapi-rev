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
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { DateTimePicker } from '@/components/datetime-picker'
import {
  SideDrawerSection,
  sideDrawerContentClassName,
  sideDrawerFooterClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getAdminPlans } from '@/features/subscriptions/api'
import {
  formatQuotaWithCurrency,
  getCurrencyDisplay,
  getCurrencyLabel,
} from '@/lib/currency'
import {
  formatQuota,
  getEditableQuotaStep,
  parseQuotaFromDollars,
} from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { addTimeToDate } from '@/lib/time'

import { createRedemption, updateRedemption, getRedemption } from '../api'
import {
  SUCCESS_MESSAGES,
  getRedemptionDurationUnitOptions,
} from '../constants'
import {
  formatRedemptionDuration,
  getRedemptionFormSchema,
  type RedemptionFormValues,
  REDEMPTION_FORM_DEFAULT_VALUES,
  transformFormDataToPayload,
  transformRedemptionToFormDefaults,
} from '../lib'
import {
  REDEMPTION_TYPE_QUOTA,
  REDEMPTION_TYPE_SUBSCRIPTION,
  type Redemption,
} from '../types'
import {
  RedemptionsExportDialog,
  type RedemptionExportData,
} from './redemptions-export-dialog'
import { useRedemptions } from './redemptions-provider'

type RedemptionsMutateDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow?: Redemption
}

export function RedemptionsMutateDrawer({
  open,
  onOpenChange,
  currentRow,
}: RedemptionsMutateDrawerProps) {
  const { t } = useTranslation()
  const typeOptionId = useId()
  const isUpdate = !!currentRow
  const redemptionId = currentRow?.id
  const { triggerRefresh } = useRedemptions()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createdCodes, setCreatedCodes] = useState<RedemptionExportData | null>(
    null
  )
  const [redemptionLoadState, setRedemptionLoadState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [loadedRedemption, setLoadedRedemption] = useState<Redemption | null>(
    null
  )

  const form = useForm<RedemptionFormValues>({
    resolver: zodResolver(getRedemptionFormSchema(t)),
    defaultValues: REDEMPTION_FORM_DEFAULT_VALUES,
  })

  const redemptionType = form.watch('type')
  const planId = form.watch('plan_id')
  const durationUnit = form.watch('duration_unit')
  const isSubscriptionCode = redemptionType === REDEMPTION_TYPE_SUBSCRIPTION

  // The plan list is only needed for subscription codes, so quota codes never
  // issue an extra admin request.
  const { data: plans } = useQuery({
    queryKey: ['admin-subscription-plans', 'redemption-codes'],
    queryFn: async () => {
      const result = requireServerSuccess(await getAdminPlans())
      return (result.data || []).map((record) => record.plan)
    },
    enabled: open && isSubscriptionCode,
    staleTime: 60_000,
  })

  const planOptions = useMemo(() => {
    const options = (plans || []).map((plan) => ({
      value: String(plan.id),
      label: plan.title,
    }))
    if (
      planId > 0 &&
      !options.some((option) => option.value === String(planId))
    ) {
      options.push({
        value: String(planId),
        label: t('Plan #{{id}}', { id: planId }),
      })
    }
    return options
  }, [plans, planId, t])

  const durationUnitOptions = useMemo(
    () => getRedemptionDurationUnitOptions(t),
    [t]
  )

  // Load existing data when updating
  useEffect(() => {
    if (!open) {
      setRedemptionLoadState('idle')
      setLoadedRedemption(null)
      return
    }

    if (!isUpdate || redemptionId === undefined) {
      form.reset(REDEMPTION_FORM_DEFAULT_VALUES)
      setRedemptionLoadState('ready')
      setLoadedRedemption(null)
      return
    }

    let ignoreResult = false

    form.reset(REDEMPTION_FORM_DEFAULT_VALUES)
    setRedemptionLoadState('loading')
    setLoadedRedemption(null)

    void getRedemption(redemptionId)
      .then((result) => {
        if (ignoreResult) return

        if (
          !result.success ||
          !result.data ||
          result.data.id !== redemptionId
        ) {
          setRedemptionLoadState('error')
          handleServerError(result, t('Failed to load'))
          return
        }

        form.reset(transformRedemptionToFormDefaults(result.data))
        setLoadedRedemption(result.data)
        setRedemptionLoadState('ready')
      })
      .catch((error: unknown) => {
        if (ignoreResult) return

        setRedemptionLoadState('error')
        handleServerError(error)
      })

    return () => {
      ignoreResult = true
    }
  }, [open, isUpdate, redemptionId, form, t])

  const isUpdateReady =
    !isUpdate ||
    (redemptionLoadState === 'ready' && loadedRedemption?.id === redemptionId)
  const isLoadingRedemption = redemptionLoadState === 'loading'

  const onSubmit = async (data: RedemptionFormValues) => {
    if (isUpdate && (!currentRow || !loadedRedemption || !isUpdateReady)) {
      return
    }

    setIsSubmitting(true)
    try {
      const basePayload = transformFormDataToPayload(data)

      if (isUpdate && currentRow && loadedRedemption) {
        // Keep the stored quota unless the type or the quota itself changed;
        // subscription codes always carry a zero quota.
        const quotaFieldDirty =
          form.getFieldState('type').isDirty ||
          form.getFieldState('quota_dollars').isDirty
        const quota = quotaFieldDirty
          ? basePayload.quota
          : loadedRedemption.quota
        const result = await updateRedemption({
          ...basePayload,
          quota: basePayload.type === REDEMPTION_TYPE_SUBSCRIPTION ? 0 : quota,
          id: currentRow.id,
        })
        if (result.success) {
          toast.success(t(SUCCESS_MESSAGES.REDEMPTION_UPDATED))
          onOpenChange(false)
          triggerRefresh()
        } else {
          handleServerError(result)
        }
      } else {
        // Create mode
        const result = await createRedemption(basePayload)
        if (result.success) {
          const count = result.data?.length || 0
          toast.success(
            count > 1
              ? t('Successfully created {{count}} redemption codes', {
                  count,
                })
              : t(SUCCESS_MESSAGES.REDEMPTION_CREATED)
          )
          if (result.data?.length) {
            setCreatedCodes({
              keys: result.data,
              name: basePayload.name,
              quota: formatQuotaWithCurrency(basePayload.quota, {
                abbreviate: false,
              }),
              type: basePayload.type,
              planTitle: isSubscriptionCode
                ? planOptions.find(
                    (option) => option.value === String(basePayload.plan_id)
                  )?.label
                : undefined,
              duration: isSubscriptionCode
                ? formatRedemptionDuration(
                    {
                      duration_unit: basePayload.duration_unit || '',
                      duration_value: basePayload.duration_value || 0,
                      duration_seconds: basePayload.duration_seconds || 0,
                    },
                    t
                  )
                : undefined,
            })
          }
          onOpenChange(false)
          triggerRefresh()
        } else {
          handleServerError(result)
        }
      }
    } catch (error) {
      handleServerError(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!isUpdate) {
      const name = form.getValues('name')
      if (!name?.trim()) {
        const quota = parseQuotaFromDollars(form.getValues('quota_dollars'))
        form.setValue('name', formatQuota(quota), { shouldValidate: true })
      }
    }

    void form.handleSubmit(onSubmit)(event)
  }

  const handleSetExpiry = (months: number, days: number, hours: number) => {
    const newDate = addTimeToDate(months, days, hours)
    form.setValue('expired_time', newDate)
  }

  const { meta: currencyMeta } = getCurrencyDisplay()
  const currencyLabel = getCurrencyLabel()
  const tokensOnly = currencyMeta.kind === 'tokens'
  const quotaStep = getEditableQuotaStep()
  const quotaLabel = t('Quota ({{currency}})', { currency: currencyLabel })
  const quotaPlaceholder = tokensOnly
    ? t('Enter quota in tokens')
    : t('Enter quota in {{currency}}', { currency: currencyLabel })
  let submitButtonLabel = t('Save changes')
  if (isLoadingRedemption) {
    submitButtonLabel = t('Loading...')
  } else if (isSubmitting) {
    submitButtonLabel = t('Saving...')
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          onOpenChange(v)
          if (!v) {
            form.reset()
          }
        }}
      >
        <SheetContent
          className={sideDrawerContentClassName('sm:max-w-[600px]')}
        >
          <SheetHeader className={sideDrawerHeaderClassName()}>
            <SheetTitle>
              {isUpdate
                ? t('Update Redemption Code')
                : t('Create Redemption Code')}
            </SheetTitle>
            <SheetDescription>
              {isUpdate
                ? t('Update the redemption code by providing necessary info.')
                : t(
                    'Add new redemption code(s) by providing necessary info.'
                  )}{' '}
              {t('Click save when you&apos;re done.')}
            </SheetDescription>
          </SheetHeader>
          <Form {...form}>
            <form
              id='redemption-form'
              onSubmit={handleSubmit}
              className={sideDrawerFormClassName()}
              aria-busy={isLoadingRedemption}
            >
              <fieldset
                disabled={!isUpdateReady || isSubmitting}
                className='contents'
              >
                <SideDrawerSection>
                  <FormField
                    control={form.control}
                    name='name'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Name')}</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder={t('Enter a name')} />
                        </FormControl>
                        <FormDescription>
                          {t('Name for this redemption code (1-20 characters)')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name='type'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Redemption type')}</FormLabel>
                        <FormControl>
                          <RadioGroup
                            value={field.value}
                            onValueChange={(value) => {
                              if (
                                value === REDEMPTION_TYPE_QUOTA ||
                                value === REDEMPTION_TYPE_SUBSCRIPTION
                              ) {
                                field.onChange(value)
                              }
                            }}
                            aria-label={t('Redemption type')}
                            className='flex flex-wrap gap-x-5 gap-y-3'
                          >
                            {[
                              {
                                value: REDEMPTION_TYPE_QUOTA,
                                label: t('Quota'),
                              },
                              {
                                value: REDEMPTION_TYPE_SUBSCRIPTION,
                                label: t('Subscription'),
                              },
                            ].map((option) => (
                              <div
                                key={option.value}
                                className='flex items-center gap-2'
                              >
                                <RadioGroupItem
                                  value={option.value}
                                  id={`${typeOptionId}-${option.value}`}
                                />
                                <Label
                                  htmlFor={`${typeOptionId}-${option.value}`}
                                >
                                  {option.label}
                                </Label>
                              </div>
                            ))}
                          </RadioGroup>
                        </FormControl>
                        <FormDescription>
                          {t(
                            'Quota codes top up the wallet balance; subscription codes activate a subscription plan.'
                          )}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {isSubscriptionCode ? (
                    <>
                      <FormField
                        control={form.control}
                        name='plan_id'
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('Subscription plan')}</FormLabel>
                            <Select
                              items={planOptions}
                              value={field.value > 0 ? String(field.value) : ''}
                              onValueChange={(value) => {
                                if (value) {
                                  field.onChange(Number(value))
                                }
                              }}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue
                                    placeholder={t(
                                      'Select a subscription plan'
                                    )}
                                  />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent alignItemWithTrigger={false}>
                                <SelectGroup>
                                  {planOptions.map((option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            <FormDescription>
                              {t(
                                'Redeeming this code activates the selected plan for the user.'
                              )}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name='duration_unit'
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('Duration override')}</FormLabel>
                            <Select
                              items={durationUnitOptions}
                              value={field.value}
                              onValueChange={field.onChange}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent alignItemWithTrigger={false}>
                                <SelectGroup>
                                  {durationUnitOptions.map((option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            <FormDescription>
                              {t(
                                'Leave empty to grant the plan duration; otherwise the code grants the entered duration.'
                              )}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {durationUnit !== '' && durationUnit !== 'custom' && (
                        <FormField
                          control={form.control}
                          name='duration_value'
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('Duration Value')}</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type='number'
                                  min='1'
                                  placeholder={t('Enter a duration')}
                                  onChange={(e) =>
                                    field.onChange(
                                      Number.parseInt(e.target.value, 10) || 0
                                    )
                                  }
                                />
                              </FormControl>
                              <FormDescription>
                                {t(
                                  'Duration granted by this code, in the selected unit.'
                                )}
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      {durationUnit === 'custom' && (
                        <FormField
                          control={form.control}
                          name='duration_seconds'
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t('Duration (seconds)')}</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type='number'
                                  min='1'
                                  placeholder={t('Enter a duration')}
                                  onChange={(e) =>
                                    field.onChange(
                                      Number.parseInt(e.target.value, 10) || 0
                                    )
                                  }
                                />
                              </FormControl>
                              <FormDescription>
                                {t(
                                  'Duration granted by this code, in seconds.'
                                )}
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </>
                  ) : (
                    <FormField
                      control={form.control}
                      name='quota_dollars'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{quotaLabel}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type='number'
                              step={quotaStep}
                              placeholder={quotaPlaceholder}
                              onChange={(e) =>
                                field.onChange(
                                  Number.parseFloat(e.target.value) || 0
                                )
                              }
                            />
                          </FormControl>
                          <FormDescription>
                            {tokensOnly
                              ? t('Enter the quota amount in tokens')
                              : t('Enter the quota amount in {{currency}}', {
                                  currency: currencyLabel,
                                })}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  <FormField
                    control={form.control}
                    name='expired_time'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Expiration Time')}</FormLabel>
                        <div className='flex flex-col gap-2'>
                          <FormControl>
                            <DateTimePicker
                              value={field.value}
                              onChange={field.onChange}
                              placeholder={t('Never expires')}
                            />
                          </FormControl>
                          <div className='grid grid-cols-4 gap-1.5 sm:flex sm:gap-2'>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              onClick={() => handleSetExpiry(0, 0, 0)}
                            >
                              {t('Never')}
                            </Button>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              onClick={() => handleSetExpiry(1, 0, 0)}
                            >
                              {t('1M')}
                            </Button>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              onClick={() => handleSetExpiry(0, 7, 0)}
                            >
                              {t('1W')}
                            </Button>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              onClick={() => handleSetExpiry(0, 1, 0)}
                            >
                              {t('1 Day')}
                            </Button>
                          </div>
                        </div>
                        <FormDescription>
                          {t('Leave empty for never expires')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {!isUpdate && (
                    <FormField
                      control={form.control}
                      name='count'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('Quantity')}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type='number'
                              min='1'
                              max='100'
                              placeholder={t('Number of codes to create')}
                              onChange={(e) =>
                                field.onChange(
                                  Number.parseInt(e.target.value, 10) || 1
                                )
                              }
                            />
                          </FormControl>
                          <FormDescription>
                            {t(
                              'Create multiple redemption codes at once (1-100)'
                            )}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </SideDrawerSection>
              </fieldset>
            </form>
          </Form>
          <SheetFooter className={sideDrawerFooterClassName()}>
            <SheetClose render={<Button variant='outline' />}>
              {t('Close')}
            </SheetClose>
            <Button
              form='redemption-form'
              type='submit'
              disabled={isSubmitting || !isUpdateReady}
            >
              {submitButtonLabel}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {createdCodes && (
        <RedemptionsExportDialog
          data={createdCodes}
          onClose={() => setCreatedCodes(null)}
        />
      )}
    </>
  )
}
