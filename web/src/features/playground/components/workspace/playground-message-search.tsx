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
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { searchPlaygroundMessages } from '../../lib'
import type { PlaygroundSession } from '../../types'

interface PlaygroundMessageSearchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: PlaygroundSession[]
  /** Hydration still running: the search covers the part already loaded. */
  isHydrating?: boolean
  onSelect: (sessionId: string, messageKey: string) => void
}

/**
 * Cross-session message search over the hydrated workspace. Selecting a hit
 * hands the conversation and the message back so the workspace can switch and
 * highlight it; the dialog itself never navigates.
 */
export function PlaygroundMessageSearch(props: PlaygroundMessageSearchProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const hits = useMemo(
    () => searchPlaygroundMessages(props.sessions, query),
    [props.sessions, query]
  )
  const hasQuery = query.trim() !== ''

  const handleOpenChange = (open: boolean) => {
    if (!open) setQuery('')
    props.onOpenChange(open)
  }

  return (
    <Dialog
      description={t('Find text in any of your conversations.')}
      onOpenChange={handleOpenChange}
      open={props.open}
      title={t('Search messages')}
    >
      <div className='flex flex-col gap-3'>
        <div className='relative'>
          <Search
            aria-hidden='true'
            className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2'
          />
          <Input
            aria-label={t('Search messages')}
            autoFocus
            className='pl-8'
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search messages')}
            value={query}
          />
        </div>

        {props.isHydrating ? (
          <p className='text-muted-foreground text-xs' role='status'>
            {t(
              'Some conversations are still loading. Results may be incomplete.'
            )}
          </p>
        ) : null}

        {hasQuery && hits.length === 0 ? (
          <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
            {t('No matching messages.')}
          </p>
        ) : null}

        <ul className='grid gap-1'>
          {hits.map((hit) => (
            <li key={`${hit.sessionId}:${hit.messageKey}`}>
              <Button
                className='h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left font-normal whitespace-normal'
                onClick={() => {
                  props.onSelect(hit.sessionId, hit.messageKey)
                  handleOpenChange(false)
                }}
                type='button'
                variant='ghost'
              >
                <span className='text-muted-foreground block w-full truncate text-xs'>
                  {hit.sessionTitle} ·{' '}
                  {hit.from === 'user' ? t('User') : t('Assistant')}
                </span>
                <span className='line-clamp-2 w-full text-sm'>
                  {hit.before}
                  <mark className='bg-primary/20 text-foreground rounded-sm'>
                    {hit.match}
                  </mark>
                  {hit.after}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  )
}
