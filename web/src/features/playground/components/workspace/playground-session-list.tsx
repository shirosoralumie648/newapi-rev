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
import { Archive, Bot, ChevronDown, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

import type {
  PlaygroundSession,
  PlaygroundSessionOrganization,
} from '../../types'
import { PlaygroundSessionItem } from './playground-session-item'
import { PlaygroundSessionTagsDialog } from './playground-session-tags-dialog'

type PlaygroundSessionTagFilter =
  | { kind: 'all' }
  | { kind: 'untagged' }
  | { kind: 'tag'; tag: string }

const ALL_TAG_FILTER: PlaygroundSessionTagFilter = { kind: 'all' }

function matchesTagFilter(
  session: PlaygroundSession,
  filter: PlaygroundSessionTagFilter
) {
  if (filter.kind === 'all') return true
  if (filter.kind === 'untagged') return session.tags.length === 0
  return session.tags.includes(filter.tag)
}

interface PlaygroundSessionListProps {
  disabled?: boolean
  sessions: PlaygroundSession[]
  activeSessionId: string | null
  onCreate: () => void
  onSwitch: (sessionId: string) => void
  onRename: (sessionId: string, title: string) => void
  onOrganize: (
    sessionId: string,
    organization: PlaygroundSessionOrganization
  ) => void
  onDelete: (sessionId: string) => void
  onOpenTrash?: () => void
  onAction?: () => void
  onOpenPresets?: () => void
}

export function PlaygroundSessionList(props: PlaygroundSessionListProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] =
    useState<PlaygroundSessionTagFilter>(ALL_TAG_FILTER)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [sessionToDelete, setSessionToDelete] =
    useState<PlaygroundSession | null>(null)
  const [sessionToTag, setSessionToTag] = useState<PlaygroundSession | null>(
    null
  )

  const availableTags = useMemo(
    () =>
      [...new Set(props.sessions.flatMap((session) => session.tags))].sort(
        (first, second) => first.localeCompare(second)
      ),
    [props.sessions]
  )

  const effectiveTagFilter =
    tagFilter.kind === 'tag' && !availableTags.includes(tagFilter.tag)
      ? ALL_TAG_FILTER
      : tagFilter

  const matchingSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return [...props.sessions]
      .sort((first, second) => second.updatedAt - first.updatedAt)
      .filter((session) => matchesTagFilter(session, effectiveTagFilter))
      .filter((session) =>
        normalizedQuery
          ? session.title.toLocaleLowerCase().includes(normalizedQuery)
          : true
      )
  }, [props.sessions, query, effectiveTagFilter])

  const pinnedSessions = matchingSessions.filter(
    (session) => session.pinned && !session.archived
  )
  const regularSessions = matchingSessions.filter(
    (session) => !session.pinned && !session.archived
  )
  const archivedSessions = matchingSessions.filter(
    (session) => session.archived
  )

  const handleDelete = () => {
    if (!sessionToDelete) return
    props.onDelete(sessionToDelete.id)
    setSessionToDelete(null)
    props.onAction?.()
  }

  // A persisted conversation moves to the server-side trash, where it stays
  // recoverable until the retention window ends; a local-only draft is removed
  // from this browser for good.
  const trashing = sessionToDelete?.server != null

  const renderSession = (session: PlaygroundSession) => (
    <PlaygroundSessionItem
      disabled={props.disabled}
      isActive={session.id === props.activeSessionId}
      key={session.id}
      onDelete={() => setSessionToDelete(session)}
      onManageTags={() => setSessionToTag(session)}
      onOrganize={(organization) => props.onOrganize(session.id, organization)}
      onRename={(title) => props.onRename(session.id, title)}
      onSelect={() => {
        props.onSwitch(session.id)
        props.onAction?.()
      }}
      session={session}
    />
  )

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

      <div
        aria-label={t('Filter conversations by tag')}
        className='flex gap-1 overflow-x-auto pb-1'
        role='group'
      >
        <Button
          aria-pressed={effectiveTagFilter.kind === 'all'}
          className='shrink-0'
          onClick={() => setTagFilter(ALL_TAG_FILTER)}
          size='xs'
          type='button'
          variant={effectiveTagFilter.kind === 'all' ? 'secondary' : 'ghost'}
        >
          {t('All')}
        </Button>
        <Button
          aria-pressed={effectiveTagFilter.kind === 'untagged'}
          className='shrink-0'
          onClick={() => setTagFilter({ kind: 'untagged' })}
          size='xs'
          type='button'
          variant={
            effectiveTagFilter.kind === 'untagged' ? 'secondary' : 'ghost'
          }
        >
          {t('Untagged')}
        </Button>
        {availableTags.map((tag) => (
          <Button
            aria-label={t('Filter by tag {{tag}}', { tag })}
            aria-pressed={
              effectiveTagFilter.kind === 'tag' &&
              effectiveTagFilter.tag === tag
            }
            className='max-w-32 shrink-0'
            key={tag}
            title={tag}
            onClick={() => setTagFilter({ kind: 'tag', tag })}
            size='xs'
            type='button'
            variant={
              effectiveTagFilter.kind === 'tag' &&
              effectiveTagFilter.tag === tag
                ? 'secondary'
                : 'ghost'
            }
          >
            <span className='truncate'>{tag}</span>
          </Button>
        ))}
      </div>

      <ScrollArea className='min-h-0 flex-1'>
        <div className='grid gap-2 pr-2'>
          {pinnedSessions.length > 0 && (
            <section className='grid gap-1'>
              <h3 className='text-muted-foreground px-1 text-xs font-medium'>
                {t('Pinned')}
              </h3>
              {pinnedSessions.map(renderSession)}
            </section>
          )}
          <section className='grid gap-1'>
            {pinnedSessions.length > 0 && regularSessions.length > 0 && (
              <h3 className='text-muted-foreground px-1 text-xs font-medium'>
                {t('General')}
              </h3>
            )}
            {regularSessions.map(renderSession)}
          </section>
          {archivedSessions.length > 0 && (
            <section className='grid gap-1'>
              <Button
                aria-expanded={archivedOpen}
                className='w-full justify-start'
                onClick={() => setArchivedOpen((open) => !open)}
                size='sm'
                type='button'
                variant='ghost'
              >
                <Archive aria-hidden='true' />
                {t('Archived')}
                <span className='text-muted-foreground ml-auto text-xs'>
                  {archivedSessions.length}
                </span>
                <ChevronDown
                  aria-hidden='true'
                  className={cn(
                    'transition-transform',
                    archivedOpen && 'rotate-180'
                  )}
                />
              </Button>
              {archivedOpen && (
                <div className='grid gap-1'>
                  {archivedSessions.map(renderSession)}
                </div>
              )}
            </section>
          )}
          {matchingSessions.length === 0 && (
            <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
              {t('No conversations found')}
            </p>
          )}
        </div>
      </ScrollArea>

      {props.onOpenTrash && (
        <Button
          className='w-full justify-start'
          onClick={() => {
            props.onOpenTrash?.()
            props.onAction?.()
          }}
          size='sm'
          type='button'
          variant='outline'
        >
          <Trash2 aria-hidden='true' />
          {t('Trash')}
        </Button>
      )}

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
        confirmText={t(trashing ? 'Move to trash' : 'Delete')}
        desc={
          trashing
            ? t(
                'The conversation moves to the trash and can be restored until the retention period ends.'
              )
            : t(
                'This conversation will be deleted from your account and this browser.'
              )
        }
        destructive
        handleConfirm={handleDelete}
        onOpenChange={(open) => {
          if (!open) setSessionToDelete(null)
        }}
        open={sessionToDelete !== null}
        title={t(
          trashing ? 'Move conversation to trash?' : 'Delete conversation?'
        )}
      />

      {sessionToTag && (
        <PlaygroundSessionTagsDialog
          onOpenChange={(open) => {
            if (!open) setSessionToTag(null)
          }}
          onSave={(tags) => props.onOrganize(sessionToTag.id, { tags })}
          session={sessionToTag}
        />
      )}
    </div>
  )
}
