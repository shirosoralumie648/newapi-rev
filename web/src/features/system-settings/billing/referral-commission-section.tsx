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
  SettingsSwitchField,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

type ReferralCommissionSectionProps = {
  enabled: boolean
  commissionRatePercent: number
  groupRateOverridesJson: string
  windowMonths: number
  includeRedemptionCodes: boolean
  cashSettlementEnabled: boolean
  inviteLimitPerIp: number
  inviteLimitPerDevice: number
  inviteLimitPerEmailDomain: number
  dailyCommissionCapUsd: number
  monthlyCommissionCapUsd: number
  inviteeCommissionCapUsd: number
  reviewThresholdUsd: number
  requireRealName: boolean
  /** The confirmed payment compliance terms gate the engine and cash settlement. */
  complianceConfirmed: boolean
}

type OverrideDraft = { group: string; rate: string }

const INVITE_LIMIT_MAX = 100
const WINDOW_MONTHS_MAX = 120

function parseOverrides(json: string): OverrideDraft[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return []
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'number')
      .map(([group, value]) => ({ group, rate: String(value) }))
      .sort((a, b) => a.group.localeCompare(b.group))
  } catch {
    return []
  }
}

function serializeOverrides(drafts: OverrideDraft[]): string {
  const entries = [...drafts]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((draft) => [draft.group, Number(draft.rate)] as const)
  return JSON.stringify(Object.fromEntries(entries))
}

function isRateValue(value: string): boolean {
  const parsed = Number(value)
  return (
    value.trim() !== '' &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 100
  )
}

function isLimitValue(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= INVITE_LIMIT_MAX
}

function isWindowValue(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= -1 && parsed <= WINDOW_MONTHS_MAX
}

function isUsdValue(value: string): boolean {
  const parsed = Number(value)
  return value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
}

/**
 * The referral commission engine and its anti-abuse bounds: rates, trigger
 * window, invitation limits, payable caps, the manual review threshold and
 * the real-name requirement.
 */
export function ReferralCommissionSection(
  props: ReferralCommissionSectionProps
) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()

  const baselineOverrides = useMemo(
    () => parseOverrides(props.groupRateOverridesJson),
    [props.groupRateOverridesJson]
  )

  const [enabled, setEnabled] = useState(props.enabled)
  const [rate, setRate] = useState(String(props.commissionRatePercent ?? 0))
  const [windowMonths, setWindowMonths] = useState(
    String(props.windowMonths ?? 0)
  )
  const [includeRedemptionCodes, setIncludeRedemptionCodes] = useState(
    props.includeRedemptionCodes
  )
  const [cashSettlementEnabled, setCashSettlementEnabled] = useState(
    props.cashSettlementEnabled
  )
  const [requireRealName, setRequireRealName] = useState(props.requireRealName)
  const [inviteLimitPerIp, setInviteLimitPerIp] = useState(
    String(props.inviteLimitPerIp ?? 0)
  )
  const [inviteLimitPerDevice, setInviteLimitPerDevice] = useState(
    String(props.inviteLimitPerDevice ?? 0)
  )
  const [inviteLimitPerEmailDomain, setInviteLimitPerEmailDomain] = useState(
    String(props.inviteLimitPerEmailDomain ?? 0)
  )
  const [dailyCap, setDailyCap] = useState(
    String(props.dailyCommissionCapUsd ?? 0)
  )
  const [monthlyCap, setMonthlyCap] = useState(
    String(props.monthlyCommissionCapUsd ?? 0)
  )
  const [inviteeCap, setInviteeCap] = useState(
    String(props.inviteeCommissionCapUsd ?? 0)
  )
  const [reviewThreshold, setReviewThreshold] = useState(
    String(props.reviewThresholdUsd ?? 0)
  )
  const [overrides, setOverrides] = useState<OverrideDraft[]>(baselineOverrides)
  const [newGroup, setNewGroup] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setEnabled(props.enabled)
    setRate(String(props.commissionRatePercent ?? 0))
    setWindowMonths(String(props.windowMonths ?? 0))
    setIncludeRedemptionCodes(props.includeRedemptionCodes)
    setCashSettlementEnabled(props.cashSettlementEnabled)
    setRequireRealName(props.requireRealName)
    setInviteLimitPerIp(String(props.inviteLimitPerIp ?? 0))
    setInviteLimitPerDevice(String(props.inviteLimitPerDevice ?? 0))
    setInviteLimitPerEmailDomain(String(props.inviteLimitPerEmailDomain ?? 0))
    setDailyCap(String(props.dailyCommissionCapUsd ?? 0))
    setMonthlyCap(String(props.monthlyCommissionCapUsd ?? 0))
    setInviteeCap(String(props.inviteeCommissionCapUsd ?? 0))
    setReviewThreshold(String(props.reviewThresholdUsd ?? 0))
    setOverrides(parseOverrides(props.groupRateOverridesJson))
    setErrors({})
  }, [
    props.enabled,
    props.commissionRatePercent,
    props.windowMonths,
    props.includeRedemptionCodes,
    props.cashSettlementEnabled,
    props.requireRealName,
    props.inviteLimitPerIp,
    props.inviteLimitPerDevice,
    props.inviteLimitPerEmailDomain,
    props.dailyCommissionCapUsd,
    props.monthlyCommissionCapUsd,
    props.inviteeCommissionCapUsd,
    props.reviewThresholdUsd,
    props.groupRateOverridesJson,
  ])

  const handleAddGroup = () => {
    const group = newGroup.trim()
    if (!group || overrides.some((override) => override.group === group)) {
      setNewGroup('')
      return
    }
    setOverrides((current) => [...current, { group, rate: '0' }])
    setNewGroup('')
  }

  const handleSave = async () => {
    const nextErrors: Record<string, string> = {}
    if (!isRateValue(rate)) {
      nextErrors.rate = t('Must be a rate between 0 and 100')
    }
    if (!isWindowValue(windowMonths)) {
      nextErrors.window = t('Must be -1 or a whole number between 0 and 120')
    }
    const limitFields: Array<[string, string]> = [
      ['inviteLimitPerIp', inviteLimitPerIp],
      ['inviteLimitPerDevice', inviteLimitPerDevice],
      ['inviteLimitPerEmailDomain', inviteLimitPerEmailDomain],
    ]
    for (const [field, value] of limitFields) {
      if (!isLimitValue(value)) {
        nextErrors[field] = t('Must be a whole number between 0 and 100')
      }
    }
    const usdFields: Array<[string, string]> = [
      ['dailyCap', dailyCap],
      ['monthlyCap', monthlyCap],
      ['inviteeCap', inviteeCap],
      ['reviewThreshold', reviewThreshold],
    ]
    for (const [field, value] of usdFields) {
      if (!isUsdValue(value)) {
        nextErrors[field] = t('Must be greater than or equal to 0')
      }
    }
    overrides.forEach((override) => {
      if (!isRateValue(override.rate)) {
        nextErrors[override.group] = t('Must be a rate between 0 and 100')
      }
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const requests: Array<{ key: string; value: string }> = []
    const pushIfChanged = (key: string, current: string, baseline: string) => {
      if (current !== baseline) {
        requests.push({ key, value: current })
      }
    }
    pushIfChanged(
      'referral_setting.enabled',
      String(enabled),
      String(props.enabled)
    )
    pushIfChanged(
      'referral_setting.commission_rate_percent',
      String(Number(rate)),
      String(Number(props.commissionRatePercent ?? 0))
    )
    pushIfChanged(
      'referral_setting.window_months',
      String(Number(windowMonths)),
      String(Number(props.windowMonths ?? 0))
    )
    pushIfChanged(
      'referral_setting.include_redemption_codes',
      String(includeRedemptionCodes),
      String(props.includeRedemptionCodes)
    )
    pushIfChanged(
      'referral_setting.cash_settlement_enabled',
      String(cashSettlementEnabled),
      String(props.cashSettlementEnabled)
    )
    pushIfChanged(
      'referral_setting.require_real_name',
      String(requireRealName),
      String(props.requireRealName)
    )
    pushIfChanged(
      'referral_setting.invite_limit_per_ip',
      String(Number(inviteLimitPerIp)),
      String(Number(props.inviteLimitPerIp ?? 0))
    )
    pushIfChanged(
      'referral_setting.invite_limit_per_device',
      String(Number(inviteLimitPerDevice)),
      String(Number(props.inviteLimitPerDevice ?? 0))
    )
    pushIfChanged(
      'referral_setting.invite_limit_per_email_domain',
      String(Number(inviteLimitPerEmailDomain)),
      String(Number(props.inviteLimitPerEmailDomain ?? 0))
    )
    pushIfChanged(
      'referral_setting.daily_commission_cap_usd',
      String(Number(dailyCap)),
      String(Number(props.dailyCommissionCapUsd ?? 0))
    )
    pushIfChanged(
      'referral_setting.monthly_commission_cap_usd',
      String(Number(monthlyCap)),
      String(Number(props.monthlyCommissionCapUsd ?? 0))
    )
    pushIfChanged(
      'referral_setting.invitee_commission_cap_usd',
      String(Number(inviteeCap)),
      String(Number(props.inviteeCommissionCapUsd ?? 0))
    )
    pushIfChanged(
      'referral_setting.review_threshold_usd',
      String(Number(reviewThreshold)),
      String(Number(props.reviewThresholdUsd ?? 0))
    )
    const overridesJson = serializeOverrides(overrides)
    if (overridesJson !== serializeOverrides(baselineOverrides)) {
      requests.push({
        key: 'referral_setting.group_rate_overrides',
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
    <SettingsSection title={t('Referral Commission')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateOption.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save referral commission'
        />

        <div className='space-y-6'>
          <SettingsSwitchField
            controlId='referral-enabled'
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t('Enable referral commission')}
            description={
              props.complianceConfirmed
                ? t(
                    'Record a commission for every paid order of an invitee inside the trigger window'
                  )
                : t('Requires the confirmed payment compliance terms')
            }
            disabled={!props.complianceConfirmed}
          />

          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='referral-rate'>
                {t('Commission rate (percent)')}
              </Label>
              <Input
                aria-invalid={errors.rate ? true : undefined}
                id='referral-rate'
                inputMode='decimal'
                min={0}
                max={100}
                onChange={(event) => setRate(event.target.value)}
                step='any'
                type='number'
                value={rate}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Percent of every paid order of an invitee credited to the inviter'
                )}
              </p>
              {errors.rate && (
                <p className='text-destructive text-sm'>{errors.rate}</p>
              )}
            </FormItem>

            <FormItem>
              <Label htmlFor='referral-window'>
                {t('Trigger window (months)')}
              </Label>
              <Input
                aria-invalid={errors.window ? true : undefined}
                id='referral-window'
                inputMode='numeric'
                min={-1}
                max={WINDOW_MONTHS_MAX}
                onChange={(event) => setWindowMonths(event.target.value)}
                type='number'
                value={windowMonths}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  '0 rewards only the first paid order and -1 never expires; a positive value is the number of months from sign-up'
                )}
              </p>
              {errors.window && (
                <p className='text-destructive text-sm'>{errors.window}</p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Group overrides')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Override the rate for one inviter group. A group appears here only when its rate differs from the default.'
                )}
              </p>
            </div>

            {overrides.map((override, index) => (
              <div
                key={override.group}
                className='flex flex-wrap items-end gap-3 rounded-lg border p-4'
              >
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`referral-group-${override.group}`}>
                    {t('Group')}
                  </Label>
                  <Input
                    disabled
                    id={`referral-group-${override.group}`}
                    value={override.group}
                  />
                </FormItem>
                <FormItem className='min-w-32 flex-1'>
                  <Label htmlFor={`referral-group-rate-${override.group}`}>
                    {t('Rate (percent)')}
                  </Label>
                  <Input
                    aria-invalid={
                      errors[override.group] === undefined ? undefined : true
                    }
                    id={`referral-group-rate-${override.group}`}
                    inputMode='decimal'
                    min={0}
                    max={100}
                    onChange={(event) =>
                      setOverrides((current) =>
                        current.map((entry, position) =>
                          position === index
                            ? { ...entry, rate: event.target.value }
                            : entry
                        )
                      )
                    }
                    step='any'
                    type='number'
                    value={override.rate}
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
                <Label htmlFor='referral-new-group'>{t('Group')}</Label>
                <Input
                  id='referral-new-group'
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

          <div className='space-y-1'>
            <h3 className='text-base font-medium'>{t('Invitation limits')}</h3>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Bound how many invitees of one inviter may earn from registrations sharing a signal value; 0 disables the bound'
              )}
            </p>
          </div>
          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='referral-limit-ip'>
                {t('Invite limit per IP')}
              </Label>
              <Input
                aria-invalid={errors.inviteLimitPerIp ? true : undefined}
                id='referral-limit-ip'
                inputMode='numeric'
                min={0}
                max={INVITE_LIMIT_MAX}
                onChange={(event) => setInviteLimitPerIp(event.target.value)}
                type='number'
                value={inviteLimitPerIp}
              />
              {errors.inviteLimitPerIp && (
                <p className='text-destructive text-sm'>
                  {errors.inviteLimitPerIp}
                </p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='referral-limit-device'>
                {t('Invite limit per device')}
              </Label>
              <Input
                aria-invalid={errors.inviteLimitPerDevice ? true : undefined}
                id='referral-limit-device'
                inputMode='numeric'
                min={0}
                max={INVITE_LIMIT_MAX}
                onChange={(event) =>
                  setInviteLimitPerDevice(event.target.value)
                }
                type='number'
                value={inviteLimitPerDevice}
              />
              {errors.inviteLimitPerDevice && (
                <p className='text-destructive text-sm'>
                  {errors.inviteLimitPerDevice}
                </p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='referral-limit-email-domain'>
                {t('Invite limit per email domain')}
              </Label>
              <Input
                aria-invalid={
                  errors.inviteLimitPerEmailDomain ? true : undefined
                }
                id='referral-limit-email-domain'
                inputMode='numeric'
                min={0}
                max={INVITE_LIMIT_MAX}
                onChange={(event) =>
                  setInviteLimitPerEmailDomain(event.target.value)
                }
                type='number'
                value={inviteLimitPerEmailDomain}
              />
              {errors.inviteLimitPerEmailDomain && (
                <p className='text-destructive text-sm'>
                  {errors.inviteLimitPerEmailDomain}
                </p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <div className='space-y-1'>
            <h3 className='text-base font-medium'>
              {t('Commission caps (USD)')}
            </h3>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Cap the payable commission of one inviter per day, per month and per invitee; 0 disables the cap and an event above a cap is recorded as blocked'
              )}
            </p>
          </div>
          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='referral-cap-daily'>
                {t('Daily commission cap (USD)')}
              </Label>
              <Input
                aria-invalid={errors.dailyCap ? true : undefined}
                id='referral-cap-daily'
                inputMode='decimal'
                min={0}
                onChange={(event) => setDailyCap(event.target.value)}
                step='any'
                type='number'
                value={dailyCap}
              />
              {errors.dailyCap && (
                <p className='text-destructive text-sm'>{errors.dailyCap}</p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='referral-cap-monthly'>
                {t('Monthly commission cap (USD)')}
              </Label>
              <Input
                aria-invalid={errors.monthlyCap ? true : undefined}
                id='referral-cap-monthly'
                inputMode='decimal'
                min={0}
                onChange={(event) => setMonthlyCap(event.target.value)}
                step='any'
                type='number'
                value={monthlyCap}
              />
              {errors.monthlyCap && (
                <p className='text-destructive text-sm'>{errors.monthlyCap}</p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='referral-cap-invitee'>
                {t('Per-invitee commission cap (USD)')}
              </Label>
              <Input
                aria-invalid={errors.inviteeCap ? true : undefined}
                id='referral-cap-invitee'
                inputMode='decimal'
                min={0}
                onChange={(event) => setInviteeCap(event.target.value)}
                step='any'
                type='number'
                value={inviteeCap}
              />
              {errors.inviteeCap && (
                <p className='text-destructive text-sm'>{errors.inviteeCap}</p>
              )}
            </FormItem>
            <FormItem>
              <Label htmlFor='referral-review-threshold'>
                {t('Review threshold (USD)')}
              </Label>
              <Input
                aria-invalid={errors.reviewThreshold ? true : undefined}
                id='referral-review-threshold'
                inputMode='decimal'
                min={0}
                onChange={(event) => setReviewThreshold(event.target.value)}
                step='any'
                type='number'
                value={reviewThreshold}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'A single commission above this amount waits for manual review; 0 reviews none'
                )}
              </p>
              {errors.reviewThreshold && (
                <p className='text-destructive text-sm'>
                  {errors.reviewThreshold}
                </p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <SettingsSwitchField
            controlId='referral-redemption-codes'
            checked={includeRedemptionCodes}
            onCheckedChange={setIncludeRedemptionCodes}
            label={t('Count redemption codes')}
            description={t(
              'Redeeming a quota code counts as a paid order; subscription codes never count'
            )}
          />

          <SettingsSwitchField
            controlId='referral-require-real-name'
            checked={requireRealName}
            onCheckedChange={setRequireRealName}
            label={t('Require a real-name identity')}
            description={t(
              'Block the commissions of an inviter whose identity an administrator has not recorded yet'
            )}
          />

          <SettingsSwitchField
            controlId='referral-cash-settlement'
            checked={cashSettlementEnabled}
            onCheckedChange={setCashSettlementEnabled}
            label={t('Cash settlement')}
            description={
              props.complianceConfirmed
                ? t('Pay commissions as cash instead of granted credit')
                : t('Requires the confirmed payment compliance terms')
            }
            disabled={!props.complianceConfirmed}
          />
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
