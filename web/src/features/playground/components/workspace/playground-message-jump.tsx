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
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import {
  buildPlaygroundMessageIndex,
  filterPlaygroundMessageIndex,
  messageJumpScrollTop,
  messageJumpWindow,
  MESSAGE_JUMP_ROW_HEIGHT,
} from '../../lib/message/message-index-utils'
import type { Message } from '../../types'

/** Height of the scroll viewport, matching the `h-80` row below. */
const MESSAGE_JUMP_VIEWPORT_HEIGHT = 320

interface PlaygroundMessageJumpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  messages: readonly Message[]
  onSelect: (messageKey: string) => void
}

/**
 * In-conversation jump list. The local index only keeps visible text, the
 * search filters it, and `messageJumpWindow` mounts just the rows around the
 * viewport so a several-thousand-message conversation stays responsive. The
 * dialog itself never navigates: selecting hands the key back to the
 * workspace, which highlights and scrolls the chat.
 */
export function PlaygroundMessageJump(props: PlaygroundMessageJumpProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const entries = useMemo(
    () => buildPlaygroundMessageIndex(props.messages),
    [props.messages]
  )
  const filtered = useMemo(
    () => filterPlaygroundMessageIndex(entries, query),
    [entries, query]
  )
  const activeIndex =
    filtered.length === 0 ? -1 : Math.min(selectedIndex, filtered.length - 1)
  const jumpWindow = messageJumpWindow(
    filtered.length,
    scrollTop,
    MESSAGE_JUMP_VIEWPORT_HEIGHT
  )

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setQuery('')
      setSelectedIndex(0)
      setScrollTop(0)
      if (listRef.current) listRef.current.scrollTop = 0
    }
    props.onOpenChange(open)
  }

  const scrollToIndex = (index: number) => {
    const node = listRef.current
    if (!node) return
    const viewport = node.clientHeight || MESSAGE_JUMP_VIEWPORT_HEIGHT
    const top = messageJumpScrollTop(index)
    const bottom = top + MESSAGE_JUMP_ROW_HEIGHT
    if (top < node.scrollTop) {
      node.scrollTop = top
    } else if (bottom > node.scrollTop + viewport) {
      node.scrollTop = bottom - viewport
    }
    setScrollTop(node.scrollTop)
  }

  const select = (index: number) => {
    const entry = filtered[index]
    if (!entry) return
    handleOpenChange(false)
    props.onSelect(entry.key)
  }

  const moveSelection = (delta: number) => {
    if (filtered.length === 0) return
    const next = Math.min(Math.max(activeIndex + delta, 0), filtered.length - 1)
    setSelectedIndex(next)
    scrollToIndex(next)
  }

  const roleLabel = (from: Message['from']) => {
    if (from === 'user') return t('User')
    if (from === 'system') return t('System')
    return t('Assistant')
  }

  return (
    <Dialog
      description={t('Jump to a message in this conversation.')}
      onOpenChange={handleOpenChange}
      open={props.open}
      title={t('Jump to message')}
    >
      <div className='flex flex-col gap-3'>
        <div className='relative'>
          <Search
            aria-hidden='true'
            className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2'
          />
          <Input
            aria-activedescendant={
              activeIndex >= 0
                ? `playground-message-jump-${activeIndex}`
                : undefined
            }
            aria-controls='playground-message-jump-list'
            aria-label={t('Search messages in this conversation.')}
            autoFocus
            className='pl-8'
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedIndex(0)
              setScrollTop(0)
              if (listRef.current) listRef.current.scrollTop = 0
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveSelection(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveSelection(-1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                select(activeIndex)
              }
            }}
            placeholder={t('Search messages in this conversation.')}
            value={query}
          />
        </div>

        {entries.length === 0 ? (
          <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
            {t('This conversation has no messages yet.')}
          </p>
        ) : filtered.length === 0 ? (
          <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
            {t('No matching messages.')}
          </p>
        ) : (
          <div
            aria-label={t('Jump to message')}
            className='h-80 overflow-y-auto overscroll-contain rounded-md border'
            id='playground-message-jump-list'
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            ref={listRef}
            role='listbox'
          >
            <div
              className='relative w-full'
              style={{ height: jumpWindow.totalHeight }}
            >
              {filtered
                .slice(jumpWindow.start, jumpWindow.end)
                .map((entry, indexInWindow) => {
                  const index = jumpWindow.start + indexInWindow
                  const selected = index === activeIndex
                  return (
                    <button
                      aria-selected={selected}
                      className={cn(
                        'absolute inset-x-0 flex flex-col items-start justify-center gap-0.5 overflow-hidden px-3 text-left',
                        selected ? 'bg-muted text-foreground' : 'bg-transparent'
                      )}
                      id={`playground-message-jump-${index}`}
                      key={entry.key}
                      onClick={() => select(index)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      role='option'
                      style={{
                        height: MESSAGE_JUMP_ROW_HEIGHT,
                        top: index * MESSAGE_JUMP_ROW_HEIGHT,
                      }}
                      type='button'
                    >
                      <span className='text-muted-foreground flex w-full items-center gap-2 text-xs'>
                        <span>{roleLabel(entry.from)}</span>
                        <span className='ml-auto'>#{entry.index + 1}</span>
                      </span>
                      <span className='w-full truncate text-sm'>
                        {entry.preview || t('This message has no text.')}
                      </span>
                    </button>
                  )
                })}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
