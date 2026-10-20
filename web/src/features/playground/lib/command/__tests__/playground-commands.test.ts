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
import type { TFunction } from 'i18next'
import { expect, test, vi } from 'vitest'

import type { ModelOption, PlaygroundSession } from '../../../types'
import {
  buildPlaygroundCommands,
  filterPlaygroundCommands,
  groupPlaygroundCommands,
  scorePlaygroundCommand,
  type PlaygroundCommand,
  type PlaygroundCommandActions,
} from '../playground-commands'

const t = ((key: string) => key) as unknown as TFunction

function session(
  id: string,
  title: string,
  updatedAt: number
): PlaygroundSession {
  return { id, title, updatedAt, tags: ['tag'] } as PlaygroundSession
}

function model(label: string, value: string, supportsChat = true): ModelOption {
  return { label, value, supportsChat }
}

function actions(): PlaygroundCommandActions {
  return {
    newConversation: vi.fn(),
    switchSession: vi.fn(),
    useModel: vi.fn(),
    openInspector: vi.fn(),
    openCanvas: vi.fn(),
    switchProtocol: vi.fn(),
    exportSession: vi.fn(),
    openMessageSearch: vi.fn(),
    openMessageJump: vi.fn(),
    openShortcuts: vi.fn(),
  }
}

function command(
  overrides: Partial<PlaygroundCommand> & Pick<PlaygroundCommand, 'title'>
): PlaygroundCommand {
  return {
    id: 'command',
    group: 'workspace',
    ...overrides,
    run: overrides.run ?? vi.fn(),
  }
}

test('ranking prefers a prefix over a word-boundary match and a subsequence', () => {
  const target = command({ title: 'Open artifacts' })

  const prefix = scorePlaygroundCommand('open', target)
  const wordBoundary = scorePlaygroundCommand('artifacts', target)
  const subsequence = scorePlaygroundCommand('oafs', target)

  expect(prefix).not.toBeNull()
  expect(wordBoundary).not.toBeNull()
  expect(subsequence).not.toBeNull()
  if (prefix === null || wordBoundary === null || subsequence === null) {
    throw new Error('expected every query to match')
  }
  expect(prefix).toBeGreaterThan(wordBoundary)
  expect(wordBoundary).toBeGreaterThan(subsequence)
  expect(scorePlaygroundCommand('zzz', target)).toBeNull()
})

test('the empty query keeps actions and hides sessions and models', () => {
  const action = command({ id: 'action', title: 'New conversation' })
  const result = command({
    id: 'result',
    title: 'Switch to Alpha',
    searchOnly: true,
  })

  expect(filterPlaygroundCommands([action, result], '')).toEqual([action])
  expect(filterPlaygroundCommands([action, result], 'alpha')).toEqual([result])
})

test('groups keep the palette order and drop empty sections', () => {
  const sections = groupPlaygroundCommands(
    [
      command({ id: 'help', group: 'help', title: 'Keyboard shortcuts' }),
      command({ id: 'new', group: 'workspace', title: 'New conversation' }),
    ],
    (key) => t(key)
  )

  expect(sections.map((section) => section.group)).toEqual([
    'workspace',
    'help',
  ])
  expect(sections[0].heading).toBe('Workspace')
  expect(sections[0].commands.map((entry) => entry.id)).toEqual(['new'])
})

test('building a registry carries sessions, chat models and palette actions', () => {
  const commandActions = actions()
  const commands = buildPlaygroundCommands({
    t,
    sessions: [
      session('active', 'Active', 3),
      session('older', 'Older', 1),
      session('newer', 'Newer', 5),
    ],
    models: [
      model('Chat model', 'chat-model'),
      model('Image model', 'image', false),
    ],
    activeSessionId: 'active',
    protocol: 'chat',
    canExport: false,
    actions: commandActions,
  })
  const ids = commands.map((entry) => entry.id)

  expect(ids).toContain('switch-session:newer')
  expect(ids).toContain('switch-session:older')
  expect(ids).not.toContain('switch-session:active')
  expect(ids).toContain('use-model:chat-model')
  expect(ids).not.toContain('use-model:image')
  expect(ids).toContain('switch-protocol:responses')
  expect(ids).not.toContain('switch-protocol:chat')
  expect(ids).not.toContain('export-json')

  commands.find((entry) => entry.id === 'new-conversation')?.run()
  expect(commandActions.newConversation).toHaveBeenCalledTimes(1)

  commands.find((entry) => entry.id === 'open-trash')?.run()
  expect(commandActions.openInspector).toHaveBeenCalledWith('trash')

  commands.find((entry) => entry.id === 'open-artifacts')?.run()
  expect(commandActions.openCanvas).toHaveBeenCalledWith('artifacts')
})
