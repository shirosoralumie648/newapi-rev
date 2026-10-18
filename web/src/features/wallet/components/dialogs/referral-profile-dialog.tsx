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
import { AlertTriangle, Flag, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StaticDataTable } from '@/components/data-table'
import type { StaticDataTableColumn } from '@/components/data-table'
import { Dialog } from '@/components/dialog'
import { EmptyState } from '@/components/empty-state'
import { LoadingState } from '@/components/loading-state'
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
import { formatQuota, formatTimestampToDate } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'

import {
  useClearUserReferralIdentity,
  useSetUserReferralFlag,
  useSetUserReferralIdentity,
  useUserReferralProfile,
} from '../../hooks'
import {
  REFERRAL_FLAG_LEVEL_VALUES,
  getReferralCommissionStatusLabelKey,
  getReferralFlagLevelLabelKey,
} from '../../lib'
import type {
  ReferralCommissionStatusCount,
  ReferralFlagLevel,
} from '../../types'

interface ReferralProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: number
  username?: string
}

/**
 * Administrator anti-abuse view of one account: the registration environment
 * recorded at sign-up, the identity correlation prefix with its record/clear
 * actions, the watch/frozen mark and the commission history.
 */
export function ReferralProfileDialog(props: ReferralProfileDialogProps) {
  const { t } = useTranslation()
  const profile = useUserReferralProfile(props.userId, props.open)
  const setFlag = useSetUserReferralFlag()
  const setIdentity = useSetUserReferralIdentity()
  const clearIdentity = useClearUserReferralIdentity()

  const [flagLevel, setFlagLevel] = useState<ReferralFlagLevel>('watch')
  const [flagNote, setFlagNote] = useState('')
  const [identity, setIdentity] = useState('')
  const [identityError, setIdentityError] = useState('')
  const [clearIdentityOpen, setClearIdentityOpen] = useState(false)

  const view = profile.data
  const currentLevel = view?.flag?.level ?? ''

  useEffect(() => {
    if (props.open) {
      setIdentity('')
      setIdentityError('')
      setClearIdentityOpen(false)
    }
  }, [props.open])

  useEffect(() => {
    const level = view?.flag?.level ?? ''
    const note = view?.flag?.note ?? ''
    if (level === '') {
      setFlagLevel('watch')
      setFlagNote('')
      return
    }
    setFlagLevel(level === 'frozen' ? 'frozen' : 'watch')
    setFlagNote(note)
  }, [view?.flag?.level, view?.flag?.note])

  const flagItems = REFERRAL_FLAG_LEVEL_VALUES.map((level) => ({
    value: level,
    label: t(getReferralFlagLevelLabelKey(level)),
  }))

  const handleSaveFlag = async () => {
    try {
      await setFlag.mutateAsync({
        userId: props.userId,
        level: flagLevel,
        note: flagNote.trim(),
      })
      toast.success(t('Referral flag updated'))
    } catch (error) {
      handleServerError(error, t('Failed to update the referral flag'))
    }
  }

  const handleSaveIdentity = async () => {
    const value = identity.trim()
    if (value === '') {
      setIdentityError(t('Enter the verified identity'))
      return
    }
    setIdentityError('')
    try {
      await setIdentity.mutateAsync({ userId: props.userId, identity: value })
      toast.success(t('Referral identity updated'))
      setIdentity('')
    } catch (error) {
      handleServerError(error, t('Failed to update the referral identity'))
    }
  }

  const handleClearIdentity = async () => {
    try {
      await clearIdentity.mutateAsync({ userId: props.userId })
      toast.success(t('Referral identity cleared'))
    } catch (error) {
      handleServerError(error, t('Failed to clear the referral identity'))
    } finally {
      setClearIdentityOpen(false)
    }
  }

  const commissionColumns: StaticDataTableColumn<ReferralCommissionStatusCount>[] =
    [
      {
        id: 'status',
        header: t('Status'),
        cell: (bucket) => t(getReferralCommissionStatusLabelKey(bucket.status)),
      },
      {
        id: 'count',
        header: t('Events'),
        className: 'text-right',
        cellClassName: 'text-right',
        cell: (bucket) => (
          <span className='font-mono tabular-nums'>{bucket.count}</span>
        ),
      },
      {
        id: 'quota',
        header: t('Quota'),
        className: 'text-right',
        cellClassName: 'text-right',
        cell: (bucket) => (
          <span className='font-mono tabular-nums'>
            {formatQuota(bucket.quota)}
          </span>
        ),
      },
    ]

  const signal = view?.signal ?? null

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Referral anti-abuse')}
      description={
        props.username
          ? t('Registration environment and rewards of {{username}}', {
              username: props.username,
            })
          : t('Registration environment, identity and rewards')
      }
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-3xl'
      contentHeight='auto'
      bodyClassName='space-y-4'
    >
      {profile.isLoading ? (
        <LoadingState className='min-h-[240px]' />
      ) : profile.isError || !view ? (
        <EmptyState
          icon={AlertTriangle}
          title={t('Failed to load the referral profile')}
          description={t('Something went wrong!')}
          className='min-h-[240px]'
        />
      ) : (
        <div className='space-y-4'>
          <div className='space-y-2'>
            <div className='text-sm font-medium'>
              {t('Registration environment')}
            </div>
            {signal ? (
              <div className='grid gap-x-4 gap-y-2 rounded-lg border p-3 sm:grid-cols-2'>
                <div className='min-w-0'>
                  <div className='text-muted-foreground text-xs'>
                    {t('Registration IP')}
                  </div>
                  <div className='font-mono text-sm break-all'>
                    {signal.ip || '-'}
                  </div>
                </div>
                <div className='min-w-0'>
                  <div className='text-muted-foreground text-xs'>
                    {t('Device')}
                  </div>
                  <div className='font-mono text-sm break-all'>
                    {signal.device_hash || '-'}
                  </div>
                </div>
                <div className='min-w-0'>
                  <div className='text-muted-foreground text-xs'>
                    {t('Email domain')}
                  </div>
                  <div className='font-mono text-sm break-all'>
                    {signal.email_domain || '-'}
                  </div>
                </div>
                <div className='min-w-0'>
                  <div className='text-muted-foreground text-xs'>
                    {t('Recorded at')}
                  </div>
                  <div className='text-sm'>
                    {formatTimestampToDate(signal.created_at)}
                  </div>
                </div>
                <div className='min-w-0 sm:col-span-2'>
                  <div className='text-muted-foreground text-xs'>
                    {t('User agent')}
                  </div>
                  <div className='font-mono text-sm break-all'>
                    {signal.user_agent || '-'}
                  </div>
                </div>
              </div>
            ) : (
              <p className='text-muted-foreground rounded-lg border p-3 text-sm'>
                {t('No registration environment was recorded for this account')}
              </p>
            )}
          </div>

          <div className='space-y-2'>
            <div className='flex items-center gap-2 text-sm font-medium'>
              <ShieldCheck aria-hidden='true' className='h-4 w-4' />
              {t('Real-name identity')}
            </div>
            <p className='text-muted-foreground text-sm'>
              {view.identity_linked
                ? t('Identity reference: {{ref}}', { ref: view.identity_ref })
                : t('Not linked')}
            </p>
            <div className='flex flex-wrap items-end gap-2'>
              <FormItem className='min-w-40 flex-1'>
                <Label htmlFor='referral-identity'>
                  {t('Verified identity')}
                </Label>
                <Input
                  aria-invalid={identityError ? true : undefined}
                  id='referral-identity'
                  onChange={(event) => setIdentity(event.target.value)}
                  placeholder={t('Document number or ID')}
                  value={identity}
                />
                <p className='text-muted-foreground text-xs'>
                  {t(
                    'Only a one-way hash is stored; the raw document number is discarded.'
                  )}
                </p>
                {identityError ? (
                  <p className='text-destructive text-xs'>{identityError}</p>
                ) : null}
              </FormItem>
              <Button
                disabled={setIdentity.isPending}
                onClick={() => void handleSaveIdentity()}
                size='sm'
                type='button'
                variant='outline'
              >
                {setIdentity.isPending ? t('Saving...') : t('Record identity')}
              </Button>
            </div>
            {view.identity_linked ? (
              <Button
                onClick={() => setClearIdentityOpen(true)}
                size='sm'
                type='button'
                variant='ghost'
                className='text-destructive hover:text-destructive'
              >
                {t('Clear identity')}
              </Button>
            ) : null}
          </div>

          <div className='space-y-2 border-t pt-4'>
            <div className='flex items-center gap-2 text-sm font-medium'>
              <Flag aria-hidden='true' className='h-4 w-4' />
              {t('Anti-abuse mark')}
            </div>
            <p className='text-muted-foreground text-sm'>
              {currentLevel
                ? t('Current mark: {{level}}', {
                    level: t(getReferralFlagLevelLabelKey(currentLevel)),
                  })
                : t('No mark on this account')}
            </p>
            <div className='flex flex-wrap items-end gap-2'>
              <FormItem className='min-w-32 flex-1'>
                <Label htmlFor='referral-flag-level'>{t('Mark level')}</Label>
                <Select
                  items={flagItems}
                  value={flagLevel}
                  onValueChange={(value) => {
                    if (value !== null) setFlagLevel(value as ReferralFlagLevel)
                  }}
                >
                  <SelectTrigger id='referral-flag-level' className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {flagItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </FormItem>
              <FormItem className='min-w-40 flex-1'>
                <Label htmlFor='referral-flag-note'>{t('Note')}</Label>
                <Input
                  id='referral-flag-note'
                  onChange={(event) => setFlagNote(event.target.value)}
                  value={flagNote}
                />
              </FormItem>
              <Button
                disabled={setFlag.isPending}
                onClick={() => void handleSaveFlag()}
                size='sm'
                type='button'
              >
                {setFlag.isPending ? t('Saving...') : t('Save mark')}
              </Button>
            </div>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Watch routes new commissions through manual review; Frozen blocks them until the mark is cleared.'
              )}
            </p>
          </div>

          <div className='space-y-2 border-t pt-4'>
            <div className='text-sm font-medium'>
              {t('Invitees: {{count}}', { count: view.invitees })}
            </div>
            {view.commissions.length === 0 ? (
              <p className='text-muted-foreground text-sm'>
                {t('No commissions recorded')}
              </p>
            ) : (
              <StaticDataTable<ReferralCommissionStatusCount>
                columns={commissionColumns}
                data={view.commissions}
                getRowKey={(bucket) => bucket.status}
              />
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearIdentityOpen}
        onOpenChange={setClearIdentityOpen}
        title={t('Clear identity')}
        desc={t('Clear the recorded identity of {{username}}?', {
          username: props.username ?? `#${props.userId}`,
        })}
        confirmText={t('Clear identity')}
        destructive
        isLoading={clearIdentity.isPending}
        handleConfirm={() => void handleClearIdentity()}
      />
    </Dialog>
  )
}
