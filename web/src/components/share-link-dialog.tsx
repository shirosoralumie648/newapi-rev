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
import { Loader2, Share2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { toIntlLocale } from '@/i18n/languages'
import { handleServerError } from '@/lib/handle-server-error'

/** The one-time link a share creation returns. */
export interface ShareLink {
  token: string
  /** Root-relative page path; the browser combines it with its origin. */
  urlPath: string
  expiresAt: number
  createdAt: number
}

interface ShareLinkDialogProps {
  /** Dialog title, for example "Share conversation". */
  title: string
  /** Explains what the anonymous reader can see. */
  description: string
  /** Accessible name of the trigger button. */
  triggerAriaLabel: string
  /** Warning shown before creating, for example the rotation rule. */
  createHint: string
  create: (expiresInDays: number) => Promise<ShareLink>
  revoke: () => Promise<void>
  disabled?: boolean
  triggerClassName?: string
  triggerSize?: 'icon-xs' | 'icon-sm'
}

/**
 * Owner-side controls for one public, revocable read-only link. The shape is
 * generic so every shareable resource uses the same expiry picker, one-time
 * URL display, copy/revoke flow and rotation warning; only the create, revoke
 * and copy calls differ. The server returns the plaintext token exactly once,
 * so the plaintext is kept in memory for as long as the dialog stays mounted.
 */
export function ShareLinkDialog(props: ShareLinkDialogProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expiresInDays, setExpiresInDays] = useState(0)
  const [share, setShare] = useState<ShareLink | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)

  const expiryOptions = [
    { value: 0, label: t('No expiry') },
    { value: 1, label: t('1 day') },
    { value: 7, label: t('7 days') },
    { value: 30, label: t('30 days') },
    { value: 90, label: t('90 days') },
    { value: 365, label: t('365 days') },
  ]

  const shareURL = share
    ? new URL(share.urlPath, window.location.origin).toString()
    : ''

  let expiryText = ''
  if (share) {
    if (share.expiresAt <= 0) {
      expiryText = t('This link has no expiry.')
    } else {
      const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
      }).format(share.expiresAt)
      expiryText = t('This link expires on {{date}}.', { date })
    }
  }

  const handleCreate = async () => {
    if (isCreating) return
    setIsCreating(true)
    try {
      const created = await props.create(expiresInDays)
      setShare(created)
      toast.success(t('Share link created'))
    } catch (error) {
      handleServerError(error, t('Unable to create the share link.'))
    } finally {
      setIsCreating(false)
    }
  }

  const handleRevoke = async () => {
    if (isRevoking) return
    setIsRevoking(true)
    try {
      await props.revoke()
      setShare(null)
      toast.success(t('Share link revoked'))
    } catch (error) {
      handleServerError(error, t('Unable to revoke the share link.'))
    } finally {
      setIsRevoking(false)
    }
  }

  return (
    <Dialog
      contentClassName='sm:max-w-lg'
      contentHeight='auto'
      description={props.description}
      footer={
        share ? (
          <>
            <Button
              disabled={isRevoking}
              onClick={() => void handleRevoke()}
              type='button'
              variant='outline'
            >
              {isRevoking ? (
                <Loader2 aria-hidden='true' className='animate-spin' />
              ) : null}
              {t('Revoke link')}
            </Button>
            <Button onClick={() => setOpen(false)} type='button'>
              {t('Close')}
            </Button>
          </>
        ) : (
          <>
            <Button
              onClick={() => setOpen(false)}
              type='button'
              variant='outline'
            >
              {t('Close')}
            </Button>
            <Button
              disabled={isCreating}
              onClick={() => void handleCreate()}
              type='button'
            >
              {isCreating ? (
                <Loader2 aria-hidden='true' className='animate-spin' />
              ) : null}
              {t('Create share link')}
            </Button>
          </>
        )
      }
      onOpenChange={setOpen}
      open={open}
      title={props.title}
      trigger={
        <Button
          aria-label={props.triggerAriaLabel}
          className={props.triggerClassName}
          disabled={props.disabled}
          size={props.triggerSize ?? 'icon-xs'}
          type='button'
          variant='ghost'
        >
          <Share2 aria-hidden='true' />
        </Button>
      }
    >
      {share ? (
        <div className='grid gap-3'>
          <div className='grid gap-2'>
            <Label htmlFor='share-link-url'>{t('Share link')}</Label>
            <div className='flex items-center gap-2'>
              <Input id='share-link-url' readOnly value={shareURL} />
              <CopyButton
                aria-label={t('Copy share link')}
                value={shareURL}
                variant='outline'
              />
            </div>
          </div>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Copy the link now. It is shown only once and cannot be recovered later.'
            )}
          </p>
          <p className='text-sm'>{expiryText}</p>
        </div>
      ) : (
        <div className='grid gap-4'>
          <div className='grid gap-2'>
            <Label htmlFor='share-link-expiry'>{t('Link expiration')}</Label>
            <NativeSelect
              id='share-link-expiry'
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              value={String(expiresInDays)}
            >
              {expiryOptions.map((option) => (
                <NativeSelectOption
                  key={option.value}
                  value={String(option.value)}
                >
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <p className='text-muted-foreground text-sm'>{props.createHint}</p>
          <Button
            className='justify-self-start'
            disabled={isRevoking}
            onClick={() => void handleRevoke()}
            size='sm'
            type='button'
            variant='outline'
          >
            {isRevoking ? (
              <Loader2 aria-hidden='true' className='animate-spin' />
            ) : null}
            {t('Revoke link')}
          </Button>
        </div>
      )}
    </Dialog>
  )
}
