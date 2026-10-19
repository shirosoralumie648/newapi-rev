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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_DEVELOPER_OPTIONS,
  DEFAULT_PARAMETER_ENABLED,
} from '../../../constants'
import type { PlaygroundSession } from '../../../types'
import { PlaygroundSessionList } from '../playground-session-list'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const makeSession = (
  id: string,
  title: string,
  updatedAt: number
): PlaygroundSession => ({
  id,
  title,
  updatedAt,
  createdAt: updatedAt,
  config: { ...DEFAULT_CONFIG },
  parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
  systemPrompt: '',
  openingMessage: '',
  suggestedQuestions: [],
  knowledgeBaseIds: [],
  context: { ...DEFAULT_CONTEXT_SETTINGS },
  contextSummary: null,
  developerOptions: { ...DEFAULT_DEVELOPER_OPTIONS, tools: [] },
  pinned: false,
  archived: false,
  tags: [],
  messages: [],
})

const sessions = [
  makeSession('older', 'Older conversation', 1),
  makeSession('newer', 'Newest conversation', 2),
]

const persistedSession: PlaygroundSession = {
  ...makeSession('saved', 'Saved conversation', 3),
  server: { id: 'pgs_saved', revision: 1, messageRevision: 1 },
}

const pinnedSession: PlaygroundSession = {
  ...makeSession('pinned', 'Pinned conversation', 1),
  pinned: true,
}

const archivedSession: PlaygroundSession = {
  ...makeSession('archived', 'Archived conversation', 4),
  archived: true,
}

test('filters sessions by title and switches the selected conversation', async () => {
  const user = userEvent.setup()
  const onSwitch = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onOrganize={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSwitch={onSwitch}
      sessions={sessions}
    />
  )

  await user.type(
    screen.getByRole('textbox', { name: 'Search conversations' }),
    'new'
  )
  expect(
    screen.queryByRole('button', { name: 'Older conversation' })
  ).toBeNull()
  const newest = screen.getByRole('button', { name: 'Newest conversation' })
  await user.click(newest)
  expect(onSwitch).toHaveBeenCalledWith('newer')
})

test('requires a non-empty title before saving a rename', async () => {
  const user = userEvent.setup()
  const onRename = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onOrganize={vi.fn()}
      onDelete={vi.fn()}
      onRename={onRename}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Rename Older conversation' })
  )
  const titleInput = screen.getByRole('textbox', { name: 'Session name' })
  await user.clear(titleInput)
  await user.click(screen.getByRole('button', { name: 'Save name' }))

  expect(onRename).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeVisible()
})

test('confirms deletion before removing a session', async () => {
  const user = userEvent.setup()
  const onDelete = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onOrganize={vi.fn()}
      onDelete={onDelete}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete Older conversation' })
  )
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Delete' }))
  expect(onDelete).toHaveBeenCalledWith('older')
})

test('opens the trash from the session list footer', async () => {
  const user = userEvent.setup()
  const onAction = vi.fn()
  const onOpenTrash = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onAction={onAction}
      onCreate={vi.fn()}
      onOrganize={vi.fn()}
      onDelete={vi.fn()}
      onOpenTrash={onOpenTrash}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Trash' }))
  expect(onOpenTrash).toHaveBeenCalledTimes(1)
  expect(onAction).toHaveBeenCalledTimes(1)
})

test('offers message search only when a handler is wired', async () => {
  const user = userEvent.setup()
  const onAction = vi.fn()
  const onOpenMessageSearch = vi.fn()
  const { rerender } = render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )
  expect(
    screen.queryByRole('button', { name: 'Search messages' })
  ).not.toBeInTheDocument()

  rerender(
    <PlaygroundSessionList
      activeSessionId='older'
      onAction={onAction}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOpenMessageSearch={onOpenMessageSearch}
      onOrganize={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )
  await user.click(screen.getByRole('button', { name: 'Search messages' }))

  expect(onOpenMessageSearch).toHaveBeenCalledTimes(1)
  expect(onAction).toHaveBeenCalledTimes(1)
})

test('offers share and export only for a persisted conversation', async () => {
  const user = userEvent.setup()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onOrganize={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[...sessions, persistedSession]}
    />
  )

  expect(
    screen.queryByRole('button', { name: 'Share Older conversation' })
  ).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'Export Older conversation' })
  ).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Share Saved conversation' })
  ).toBeVisible()
  await user.click(
    screen.getByRole('button', { name: 'Export Saved conversation' })
  )
  expect(
    screen.getByRole('menuitem', { name: 'Export as Markdown' })
  ).toBeVisible()
  expect(screen.getByRole('menuitem', { name: 'Export as JSON' })).toBeVisible()
})

test('moves a persisted conversation to the trash instead of deleting it outright', async () => {
  const user = userEvent.setup()
  const onDelete = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='saved'
      onCreate={vi.fn()}
      onOrganize={vi.fn()}
      onDelete={onDelete}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[persistedSession]}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Delete Saved conversation' })
  )
  expect(screen.getByText('Move conversation to trash?')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Move to trash' }))
  expect(onDelete).toHaveBeenCalledWith('saved')
})

test('groups pinned conversations and keeps archived conversations collapsed', async () => {
  const user = userEvent.setup()
  render(
    <PlaygroundSessionList
      activeSessionId='pinned'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[archivedSession, sessions[0], pinnedSession]}
    />
  )

  expect(screen.getByRole('heading', { name: 'Pinned' })).toBeVisible()
  expect(screen.getByTitle('Pinned')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Archived conversation' })
  ).toBeNull()

  const archivedToggle = screen.getByRole('button', { name: /Archived/ })
  expect(archivedToggle).toHaveAttribute('aria-expanded', 'false')
  await user.click(archivedToggle)

  expect(archivedToggle).toHaveAttribute('aria-expanded', 'true')
  expect(
    screen.getByRole('button', { name: 'Archived conversation' })
  ).toBeVisible()
})

test('filters conversations by tag and by the untagged state', async () => {
  const user = userEvent.setup()
  const taggedSession: PlaygroundSession = {
    ...makeSession('tagged', 'Tagged conversation', 5),
    tags: ['work'],
  }
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[sessions[0], taggedSession]}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Filter by tag work' }))
  expect(
    screen.getByRole('button', { name: 'Tagged conversation' })
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Older conversation' })
  ).toBeNull()

  await user.click(screen.getByRole('button', { name: 'Untagged' }))
  expect(
    screen.getByRole('button', { name: 'Older conversation' })
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Tagged conversation' })
  ).toBeNull()
})

test('pins and archives a conversation from its organization menu', async () => {
  const user = userEvent.setup()
  const onOrganize = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={onOrganize}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[sessions[0]]}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Organize Older conversation' })
  )
  await user.click(screen.getByRole('menuitem', { name: 'Pin conversation' }))
  expect(onOrganize).toHaveBeenCalledWith('older', { pinned: true })

  await user.click(
    screen.getByRole('button', { name: 'Organize Older conversation' })
  )
  await user.click(
    screen.getByRole('menuitem', { name: 'Archive conversation' })
  )
  expect(onOrganize).toHaveBeenCalledWith('older', { archived: true })
})

test('hides pinning and offers restore for an archived conversation', async () => {
  const user = userEvent.setup()
  render(
    <PlaygroundSessionList
      activeSessionId='archived'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[archivedSession]}
    />
  )

  await user.click(screen.getByRole('button', { name: /Archived/ }))
  await user.click(
    screen.getByRole('button', {
      name: 'Organize Archived conversation',
    })
  )

  expect(
    screen.queryByRole('menuitem', { name: 'Pin conversation' })
  ).toBeNull()
  expect(
    screen.getByRole('menuitem', { name: 'Restore conversation' })
  ).toBeVisible()
})

test('replaces the tag list through the tags dialog', async () => {
  const user = userEvent.setup()
  const onOrganize = vi.fn()
  render(
    <PlaygroundSessionList
      activeSessionId='older'
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={onOrganize}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={[sessions[0]]}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Organize Older conversation' })
  )
  await user.click(screen.getByRole('menuitem', { name: 'Manage tags' }))
  await user.type(
    screen.getByRole('textbox', { name: 'Add a tag...' }),
    'work{Enter}'
  )
  await user.click(screen.getByRole('button', { name: 'Save tags' }))

  expect(onOrganize).toHaveBeenCalledWith('older', { tags: ['work'] })
})

test('hands the chosen export file to the conversation importer', async () => {
  const user = userEvent.setup()
  const onImportFile = vi.fn().mockResolvedValue(undefined)
  const { container } = render(
    <PlaygroundSessionList
      activeSessionId='older'
      onImportFile={onImportFile}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onOrganize={vi.fn()}
      onRename={vi.fn()}
      onSwitch={vi.fn()}
      sessions={sessions}
    />
  )
  const file = new File(['{"session":{}}'], 'chat.json', {
    type: 'application/json',
  })
  const input = container.querySelector('input[type="file"]')
  expect(input).not.toBeNull()
  if (!input) return

  await user.upload(input as HTMLInputElement, file)

  expect(onImportFile).toHaveBeenCalledWith(file)
})
