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
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_DEVELOPER_OPTIONS,
  DEFAULT_PARAMETER_ENABLED,
} from '../../../constants'
import type { Message, PlaygroundSession } from '../../../types'
import { searchPlaygroundMessages } from '../message-search-utils'

function message(content: string, overrides: Partial<Message> = {}): Message {
  return {
    key: `m-${content}`,
    from: 'user',
    status: 'complete',
    versions: [{ id: 'v1', content }],
    ...overrides,
  }
}

function session(
  id: string,
  updatedAt: number,
  messages: Message[]
): PlaygroundSession {
  return {
    id,
    title: `${id} conversation`,
    createdAt: updatedAt,
    updatedAt,
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
    messages,
  }
}

describe('searchPlaygroundMessages', () => {
  test('returns the newest conversation first with the snippet split around the match', () => {
    const hits = searchPlaygroundMessages(
      [
        session('older', 1, [message('The release checklist lives here')]),
        session('newer', 2, [message('Notes about the Release')]),
      ],
      'release'
    )

    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({
      sessionId: 'newer',
      sessionTitle: 'newer conversation',
      before: 'Notes about the ',
      match: 'Release',
      after: '',
    })
    expect(hits[1]).toMatchObject({
      sessionId: 'older',
      before: 'The ',
      match: 'release',
      after: ' checklist lives here',
    })
  })

  test('searches only the visible text of the active version', () => {
    const hidden = message('Hidden draft mentions tokens', {
      versions: [
        { id: 'v1', content: 'Hidden draft mentions tokens' },
        { id: 'v2', content: 'Current answer' },
      ],
      activeVersionIndex: 1,
    })

    expect(
      searchPlaygroundMessages([session('one', 1, [hidden])], 'tokens')
    ).toEqual([])
    expect(
      searchPlaygroundMessages([session('one', 1, [hidden])], 'current')
    ).toHaveLength(1)
  })

  test('ignores a blank query and caps the result count', () => {
    const many = session('one', 1, [
      message('first note'),
      message('second note'),
      message('third note'),
    ])

    expect(searchPlaygroundMessages([many], '   ')).toEqual([])
    expect(searchPlaygroundMessages([many], 'note', 2)).toHaveLength(2)
  })
})
