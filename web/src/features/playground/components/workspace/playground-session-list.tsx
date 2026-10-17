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
import { Bot, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

import type { PlaygroundSession } from '../../types'
import { PlaygroundSessionItem } from './playground-session-item'

interface PlaygroundSessionListProps {
  disabled?: boolean
  sessions: PlaygroundSession[]
  activeSessionId: string | null
  onCreate: () => void
  onSwitch: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
  onDelete: (sessionId: string) => void
  onAction?: () => void
  onOpenPresets?: () => void
}

export function PlaygroundSessionList(props: PlaygroundSessionListProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [sessionToDelete, setSessionToDelete] =
    useState<PlaygroundSession | null>(null)

  const visibleSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return [...props.sessions]
      .sort((first, second) => second.updatedAt - first.updatedAt)
      .filter((session) =>
        normalizedQuery
          ? session.title.toLocaleLowerCase().includes(normalizedQuery)
          : true
      )
  }, [props.sessions, query])

  const handleDelete = () => {
    if (!sessionToDelete) return
    props.onDelete(sessionToDelete.id)
    setSessionToDelete(null)
    props.onAction?.()
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='flex items-center gap-2'>
        <div className='relative min-w-0 flex-1'>
          <Search
            aria-hidden='true'
            className='text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2'
          />
          <Input
            aria-label={t('Search conversations')}
            className='h-8 pl-8'
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search conversations')}
            value={query}
          />
        </div>
        <Button
          disabled={props.disabled}
          aria-label={t('New session')}
          onClick={() => {
            props.onCreate()
            props.onAction?.()
          }}
          size='icon'
          type='button'
        >
          <Plus aria-hidden='true' />
        </Button>
      </div>

      <ScrollArea className='min-h-0 flex-1'>
        <div className='grid gap-1 pr-2'>
          {visibleSessions.map((session) => (
            <PlaygroundSessionItem
              disabled={props.disabled}
              isActive={session.id === props.activeSessionId}
              key={session.id}
              onDelete={() => setSessionToDelete(session)}
              onRename={(title) => props.onRename(session.id, title)}
              onSelect={() => {
                props.onSwitch(session.id)
                props.onAction?.()
              }}
              session={session}
            />
          ))}
          {visibleSessions.length === 0 && (
            <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
              {t('No conversations found')}
            </p>
          )}
        </div>
      </ScrollArea>

      {props.onOpenPresets && (
        <Button
          className='w-full justify-start'
          onClick={() => {
            props.onOpenPresets?.()
            props.onAction?.()
          }}
          size='sm'
          type='button'
          variant='outline'
        >
          <Bot aria-hidden='true' />
          {t('Assistant presets')}
        </Button>
      )}

      <ConfirmDialog
        confirmText={t('Delete')}
        desc={t(
          'This conversation will be deleted from your account and this browser.'
        )}
        destructive
        handleConfirm={handleDelete}
        onOpenChange={(open) => {
          if (!open) setSessionToDelete(null)
        }}
        open={sessionToDelete !== null}
        title={t('Delete conversation?')}
      />
    </div>
  )
}
