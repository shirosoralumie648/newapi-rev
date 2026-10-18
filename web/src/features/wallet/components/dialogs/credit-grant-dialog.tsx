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
import { Gift } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { StaticDataTable } from '@/components/data-table'
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

import { useIssueCreditGrant, useUserCreditGrants } from '../../hooks'
import {
  CREDIT_GRANT_SOURCES,
  getCreditGrantSourceLabel,
} from '../../lib/credit-grant'
import type { CreditGrantBucket } from '../../types'

interface CreditGrantDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: number
  username?: string
}

/**
 * Administrator view of one account's credit grant buckets plus the issuance
 * form: a granted credit carries its source and validity, is spent before the
 * paid balance and is recorded in the wallet ledger with the same reference, so
 * a retry can never credit the same amount twice.
 */
export function CreditGrantDialog(props: CreditGrantDialogProps) {
  const { t } = useTranslation()
  const wallet = useUserCreditGrants(props.userId, props.open)
  const issue = useIssueCreditGrant()

  const [source, setSource] = useState<string>('gift')
  const [quota, setQuota] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const view = wallet.data
  const buckets = view?.grants ?? []

  const handleIssue = async () => {
    const quotaValue = Number(quota)
    if (!Number.isInteger(quotaValue) || quotaValue <= 0) {
      setError(t('Quota must be a positive integer'))
      return
    }
    let expiresValue: number | undefined
    if (expiresInDays.trim() !== '') {
      const parsed = Number(expiresInDays)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
        setError(t('Expiry must be a whole number of days between 0 and 3650'))
        return
      }
      expiresValue = parsed
    }
    setError('')
    try {
      await issue.mutateAsync({
        user_id: props.userId,
        source,
        quota: quotaValue,
        expires_in_days: expiresValue,
        note: note.trim() === '' ? undefined : note.trim(),
      })
      toast.success(t('Credit grant issued'))
      setQuota('')
      setExpiresInDays('')
      setNote('')
    } catch (issueError) {
      handleServerError(issueError, t('Failed to issue the credit grant'))
    }
  }

  const columns = [
    {
      id: 'source',
      header: t('Grant source'),
      cell: (bucket: CreditGrantBucket) =>
        t(getCreditGrantSourceLabel(bucket.source)),
    },
    {
      id: 'remaining',
      header: t('Remaining'),
      className: 'text-right',
      cellClassName: 'text-right',
      cell: (bucket: CreditGrantBucket) => (
        <span className='font-mono tabular-nums'>
          {formatQuota(bucket.remaining)}
        </span>
      ),
    },
    {
      id: 'expires',
      header: t('Expires'),
      cell: (bucket: CreditGrantBucket) =>
        bucket.expires_at > 0
          ? formatTimestampToDate(bucket.expires_at)
          : t('Never expires'),
    },
  ]

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Credit grants')}
      description={
        props.username
          ? t('Credit grants of {{username}}', { username: props.username })
          : t('Granted credit, its source and its validity')
      }
      contentClassName='flex max-h-(--dialog-available-height) flex-col max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-3xl'
      contentHeight='auto'
      bodyClassName='space-y-4'
    >
      <div className='space-y-3'>
        {wallet.isLoading ? (
          <LoadingState className='min-h-[160px]' />
        ) : wallet.isError || !view ? (
          <EmptyState
            icon={Gift}
            title={t('Failed to load credit grants')}
            description={t('Something went wrong!')}
            className='min-h-[160px]'
          />
        ) : (
          <>
            <div className='grid grid-cols-3 divide-x rounded-lg border'>
              <div className='min-w-0 px-3 py-2.5'>
                <div className='text-muted-foreground text-xs'>
                  {t('Paid balance')}
                </div>
                <div className='mt-1 font-mono text-sm font-bold tabular-nums'>
                  {formatQuota(view.paid_quota)}
                </div>
              </div>
              <div className='min-w-0 px-3 py-2.5'>
                <div className='text-muted-foreground text-xs'>
                  {t('Granted credit')}
                </div>
                <div className='mt-1 font-mono text-sm font-bold tabular-nums'>
                  {formatQuota(view.grant_quota)}
                </div>
              </div>
              <div className='min-w-0 px-3 py-2.5'>
                <div className='text-muted-foreground text-xs'>
                  {t('Expired credit')}
                </div>
                <div className='mt-1 font-mono text-sm font-bold tabular-nums'>
                  {formatQuota(view.expired_quota)}
                </div>
              </div>
            </div>

            {buckets.length === 0 ? (
              <EmptyState
                icon={Gift}
                title={t('No credit grants')}
                description={t(
                  'This account has no outstanding granted credit'
                )}
                className='min-h-[120px]'
              />
            ) : (
              <StaticDataTable<CreditGrantBucket>
                columns={columns}
                data={buckets}
                getRowKey={(bucket) => bucket.grant_id}
              />
            )}
          </>
        )}
      </div>

      <div className='space-y-3 border-t pt-4'>
        <div className='text-sm font-medium'>{t('Issue credit grant')}</div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <FormItem>
            <Label htmlFor='credit-grant-source'>{t('Grant source')}</Label>
            <Select
              items={CREDIT_GRANT_SOURCES.map((item) => ({
                value: item,
                label: t(getCreditGrantSourceLabel(item)),
              }))}
              value={source}
              onValueChange={(value) => {
                if (value !== null) setSource(value)
              }}
            >
              <SelectTrigger id='credit-grant-source' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {CREDIT_GRANT_SOURCES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(getCreditGrantSourceLabel(item))}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </FormItem>

          <FormItem>
            <Label htmlFor='credit-grant-quota'>{t('Quota')}</Label>
            <Input
              id='credit-grant-quota'
              inputMode='numeric'
              min={1}
              onChange={(event) => setQuota(event.target.value)}
              type='number'
              value={quota}
            />
          </FormItem>

          <FormItem>
            <Label htmlFor='credit-grant-expiry'>{t('Expires in days')}</Label>
            <Input
              id='credit-grant-expiry'
              inputMode='numeric'
              min={0}
              onChange={(event) => setExpiresInDays(event.target.value)}
              placeholder={t('Empty keeps the configured validity')}
              type='number'
              value={expiresInDays}
            />
          </FormItem>

          <FormItem>
            <Label htmlFor='credit-grant-note'>{t('Note')}</Label>
            <Input
              id='credit-grant-note'
              onChange={(event) => setNote(event.target.value)}
              value={note}
            />
          </FormItem>
        </div>
        {error !== '' && <p className='text-destructive text-sm'>{error}</p>}
        <Button
          disabled={issue.isPending}
          onClick={() => void handleIssue()}
          size='sm'
          type='button'
        >
          {issue.isPending ? t('Issuing...') : t('Issue credit grant')}
        </Button>
      </div>
    </Dialog>
  )
}
