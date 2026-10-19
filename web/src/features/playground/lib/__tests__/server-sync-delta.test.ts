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
  DEFAULT_PARAMETER_ENABLED,
} from '../../constants'
import type {
  Message,
  PlaygroundContextSummary,
  PlaygroundSession,
} from '../../types'
import {
  playgroundMessageDelta,
  playgroundSnapshot,
  playgroundSyncedSnapshot,
} from '../server-sync'

function message(key: string, content: string): Message {
  return {
    key,
    from: 'user',
    versions: [{ id: `${key}-v1`, content }],
  }
}

describe('playground message deltas', () => {
  test('changed and new messages are sent while removed keys are deleted', () => {
    const synced = playgroundSyncedSnapshot([
      message('m1', 'first'),
      message('m2', 'second'),
    ])

    const delta = playgroundMessageDelta(synced, [
      message('m1', 'first edited'),
      message('m3', 'third'),
    ])

    expect(delta.upserts.map((item) => item.key)).toEqual(['m1', 'm3'])
    expect(delta.upserts[0].versions[0].content).toBe('first edited')
    expect(delta.deletes).toEqual(['m2'])
  })

  test('a snapshot that matches the stored one produces an empty delta', () => {
    const messages = [message('m1', 'first'), message('m2', 'second')]
    const synced = playgroundSyncedSnapshot(messages)

    expect(playgroundMessageDelta(synced, messages)).toEqual({
      upserts: [],
      deletes: [],
    })
    // Re-rendered message objects with the same content are not re-sent either.
    expect(
      playgroundMessageDelta(
        synced,
        messages.map((item) => ({ ...item }))
      )
    ).toEqual({ upserts: [], deletes: [] })
  })

  test('a session without a known server snapshot sends the whole history', () => {
    const delta = playgroundMessageDelta(undefined, [
      message('m1', 'first'),
      message('m2', 'second'),
    ])

    expect(delta.upserts.map((item) => item.key)).toEqual(['m1', 'm2'])
    expect(delta.deletes).toEqual([])
  })
})

describe('playground session snapshots', () => {
  function session(
    systemPrompt: string,
    overrides: Partial<PlaygroundSession> = {}
  ): PlaygroundSession {
    return {
      id: 'local-1',
      title: 'Chat',
      createdAt: 1,
      updatedAt: 1,
      config: { ...DEFAULT_CONFIG },
      parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
      systemPrompt,
      openingMessage: '',
      suggestedQuestions: [],
      context: { ...DEFAULT_CONTEXT_SETTINGS },
      contextSummary: null,
      pinned: false,
      archived: false,
      tags: [],
      messages: [message('m1', 'first')],
      ...overrides,
    }
  }

  test('editing only the system prompt changes the stored session snapshot', () => {
    expect(playgroundSnapshot(session('Answer in French.'))).not.toBe(
      playgroundSnapshot(session(''))
    )
    expect(playgroundSnapshot(session('Answer in French.'))).toBe(
      playgroundSnapshot(session('Answer in French.'))
    )
  })

  test('pin, archive and tag changes are part of the snapshot', () => {
    expect(playgroundSnapshot(session('', { pinned: true }))).not.toBe(
      playgroundSnapshot(session(''))
    )
    expect(playgroundSnapshot(session('', { archived: true }))).not.toBe(
      playgroundSnapshot(session(''))
    )
    expect(playgroundSnapshot(session('', { tags: ['work'] }))).not.toBe(
      playgroundSnapshot(session(''))
    )
  })

  test('context settings and the compression node are part of the snapshot', () => {
    const summary: PlaygroundContextSummary = {
      id: 'pgc_1',
      content: 'Earlier messages.',
      throughMessageKey: 'm1',
      messageCount: 1,
      model: 'summary-model',
      createdAt: 5,
    }
    expect(
      playgroundSnapshot(
        session('', {
          context: {
            ...DEFAULT_CONTEXT_SETTINGS,
            historyLimit: 8,
          },
        })
      )
    ).not.toBe(playgroundSnapshot(session('')))
    expect(
      playgroundSnapshot(session('', { contextSummary: summary }))
    ).not.toBe(playgroundSnapshot(session('')))
  })
})
