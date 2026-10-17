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

import { CANVAS_DEFAULT_TITLE } from '../constants'
import type { CanvasProjectSummary } from '../types'

interface CanvasProjectItemProps {
  disabled?: boolean
  project: CanvasProjectSummary
  isActive: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}

export function CanvasProjectItem(props: CanvasProjectItemProps) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const displayTitle =
    props.project.title === CANVAS_DEFAULT_TITLE
      ? t(CANVAS_DEFAULT_TITLE)
      : props.project.title
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
          aria-invalid={hasTitleError}
          aria-label={t('Canvas name')}
          autoFocus
          className='h-7'
          maxLength={200}
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
          aria-label={t('Save name')}
          disabled={props.disabled}
          onClick={submitRename}
          size='icon-xs'
          type='button'
          variant='ghost'
        >
          <Check aria-hidden='true' />
        </Button>
        <Button
          aria-label={t('Cancel rename')}
          disabled={props.disabled}
          onClick={cancelRename}
          size='icon-xs'
          type='button'
          variant='ghost'
        >
          <X aria-hidden='true' />
        </Button>
        {hasTitleError && (
          <span className='sr-only' role='alert'>
            {t('Enter a canvas name')}
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
        aria-current={props.isActive ? 'page' : undefined}
        aria-label={displayTitle}
        aria-pressed={props.isActive}
        className='min-w-0 flex-1 justify-start truncate text-start font-normal'
        disabled={props.disabled}
        onClick={props.onSelect}
        type='button'
        variant='ghost'
      >
        <span className='truncate'>{displayTitle}</span>
      </Button>
      <Button
        aria-label={t('Rename {{name}}', { name: displayTitle })}
        className='opacity-70 group-hover:opacity-100 focus-visible:opacity-100'
        disabled={props.disabled}
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
        aria-label={t('Delete {{name}}', { name: displayTitle })}
        className='text-muted-foreground group-hover:text-destructive opacity-70 group-hover:opacity-100 focus-visible:opacity-100'
        disabled={props.disabled}
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
