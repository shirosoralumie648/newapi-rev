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
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import type { PlaygroundSession } from '../../types'

interface PlaygroundSessionItemProps {
  disabled?: boolean
  session: PlaygroundSession
  isActive: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}

export function PlaygroundSessionItem(props: PlaygroundSessionItemProps) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const displayTitle =
    props.session.title === 'New conversation'
      ? t('New conversation')
      : props.session.title
  const [title, setTitle] = useState(displayTitle)
  const [hasTitleError, setHasTitleError] = useState(false)

  const submitRename = () => {
    if (!title.trim()) {
      setHasTitleError(true)
      return
    }
    props.onRename(title)
    setHasTitleError(false)
    setIsEditing(false)
  }

  const cancelRename = () => {
    setTitle(displayTitle)
    setHasTitleError(false)
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className='bg-muted/40 flex items-center gap-1 rounded-lg border p-1'>
        <Input
          maxLength={200}
          aria-label={t('Session name')}
          aria-invalid={hasTitleError}
          autoFocus
          className='h-7'
          onChange={(event) => {
            setTitle(event.target.value)
            if (event.target.value.trim()) setHasTitleError(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitRename()
            if (event.key === 'Escape') cancelRename()
          }}
          value={title}
        />
        <Button
          disabled={props.disabled}
          aria-label={t('Save name')}
          onClick={submitRename}
          size='icon-xs'
          type='button'
          variant='ghost'
        >
          <Check aria-hidden='true' />
        </Button>
        <Button
          disabled={props.disabled}
          aria-label={t('Cancel rename')}
          onClick={cancelRename}
          size='icon-xs'
          type='button'
          variant='ghost'
        >
          <X aria-hidden='true' />
        </Button>
        {hasTitleError && (
          <span className='sr-only' role='alert'>
            {t('Enter a session name')}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex min-w-0 items-center gap-1 rounded-lg border border-transparent p-1',
        props.isActive && 'border-border bg-muted/60'
      )}
      data-active={props.isActive ? 'true' : 'false'}
    >
      <Button
        disabled={props.disabled}
        aria-current={props.isActive ? 'page' : undefined}
        aria-pressed={props.isActive}
        aria-label={displayTitle}
        className='min-w-0 flex-1 justify-start truncate text-start font-normal'
        onClick={props.onSelect}
        type='button'
        variant='ghost'
      >
        <span className='truncate'>{displayTitle}</span>
      </Button>
      <Button
        disabled={props.disabled}
        aria-label={t('Rename {{name}}', { name: displayTitle })}
        className='opacity-70 group-hover:opacity-100 focus-visible:opacity-100'
        onClick={() => {
          setTitle(displayTitle)
          setIsEditing(true)
        }}
        size='icon-xs'
        type='button'
        variant='ghost'
      >
        <Pencil aria-hidden='true' />
      </Button>
      <Button
        disabled={props.disabled}
        aria-label={t('Delete {{name}}', { name: displayTitle })}
        className='text-muted-foreground group-hover:text-destructive opacity-70 group-hover:opacity-100 focus-visible:opacity-100'
        onClick={props.onDelete}
        size='icon-xs'
        type='button'
        variant='ghost'
      >
        <Trash2 aria-hidden='true' />
      </Button>
    </div>
  )
}
