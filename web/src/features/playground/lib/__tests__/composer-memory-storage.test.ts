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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  PLAYGROUND_INPUT_DRAFT_MAX_ENTRIES,
  PLAYGROUND_INPUT_HISTORY_ENTRY_MAX_CHARS,
  PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES,
} from '../../constants'
import {
  COMPOSER_MEMORY_VERSION,
  loadComposerDrafts,
  loadComposerHistory,
  rememberComposerHistoryEntry,
  saveComposerDraft,
} from '../input/composer-memory-storage'

beforeEach(() => {
  window.localStorage.clear()
})

describe('composer drafts', () => {
  test('round-trips one draft per conversation for the same account', () => {
    saveComposerDraft(7, 'session-a', 'Half-written A')
    saveComposerDraft(7, 'session-b', 'Half-written B')

    const drafts = loadComposerDrafts(7)
    expect(drafts.get('session-a')).toBe('Half-written A')
    expect(drafts.get('session-b')).toBe('Half-written B')
  })

  test('keeps drafts account-scoped', () => {
    saveComposerDraft(7, 'session-a', 'Seven typed this')
    saveComposerDraft(8, 'session-a', 'Eight typed that')

    expect(loadComposerDrafts(7).get('session-a')).toBe('Seven typed this')
    expect(loadComposerDrafts(8).get('session-a')).toBe('Eight typed that')
  })

  test('re-saving the same conversation replaces the previous draft', () => {
    saveComposerDraft(7, 'session-a', 'First')
    saveComposerDraft(7, 'session-a', 'Second')

    expect(loadComposerDrafts(7).get('session-a')).toBe('Second')
    expect(loadComposerDrafts(7).size).toBe(1)
  })

  test('blank text removes the draft and overlong text is not stored', () => {
    saveComposerDraft(7, 'session-a', 'Draft')
    saveComposerDraft(7, 'session-a', '   \n  ')
    expect(loadComposerDrafts(7).size).toBe(0)

    saveComposerDraft(7, 'session-b', 'x'.repeat(100_001))
    expect(loadComposerDrafts(7).has('session-b')).toBe(false)
  })

  test('bounds the number of stored conversations', () => {
    for (
      let index = 0;
      index < PLAYGROUND_INPUT_DRAFT_MAX_ENTRIES + 1;
      index++
    ) {
      saveComposerDraft(7, `session-${index}`, `draft ${index}`)
    }

    // Newest entries are kept first, so the oldest conversation is dropped.
    const drafts = loadComposerDrafts(7)
    expect(drafts.size).toBe(PLAYGROUND_INPUT_DRAFT_MAX_ENTRIES)
    expect(drafts.has('session-0')).toBe(false)
    expect(drafts.has(`session-${PLAYGROUND_INPUT_DRAFT_MAX_ENTRIES}`)).toBe(
      true
    )
  })

  test('a stored envelope of an unknown version is ignored instead of crashing', () => {
    window.localStorage.setItem(
      'playground_input_drafts:7',
      JSON.stringify({ version: COMPOSER_MEMORY_VERSION + 1, data: [] })
    )
    expect(loadComposerDrafts(7).size).toBe(0)
  })

  test('a corrupt store is ignored instead of crashing', () => {
    window.localStorage.setItem('playground_input_drafts:7', '{not json')
    expect(loadComposerDrafts(7).size).toBe(0)
  })

  test('storage write failures do not break typing', () => {
    const setItem = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded')
      })
    try {
      expect(() => saveComposerDraft(7, 'session-a', 'text')).not.toThrow()
    } finally {
      setItem.mockRestore()
    }
  })
})

describe('composer history', () => {
  test('records the newest entry first and de-duplicates on resend', () => {
    rememberComposerHistoryEntry(7, 'first')
    rememberComposerHistoryEntry(7, 'second')
    rememberComposerHistoryEntry(7, 'first')

    expect(loadComposerHistory(7)).toEqual(['first', 'second'])
  })

  test('keeps history account-scoped', () => {
    rememberComposerHistoryEntry(7, 'seven')
    rememberComposerHistoryEntry(8, 'eight')

    expect(loadComposerHistory(7)).toEqual(['seven'])
    expect(loadComposerHistory(8)).toEqual(['eight'])
  })

  test('skips blank and overlong prompts', () => {
    rememberComposerHistoryEntry(7, '   ')
    rememberComposerHistoryEntry(
      7,
      'x'.repeat(PLAYGROUND_INPUT_HISTORY_ENTRY_MAX_CHARS + 1)
    )
    expect(loadComposerHistory(7)).toEqual([])
  })

  test('bounds the number of recalled entries', () => {
    for (
      let index = 0;
      index < PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES + 5;
      index++
    ) {
      rememberComposerHistoryEntry(7, `prompt ${index}`)
    }

    const history = loadComposerHistory(7)
    expect(history).toHaveLength(PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES)
    expect(history[0]).toBe(
      `prompt ${PLAYGROUND_INPUT_HISTORY_MAX_ENTRIES + 4}`
    )
  })

  test('a corrupt history store is ignored', () => {
    window.localStorage.setItem('playground_input_history:7', 'not json')
    expect(loadComposerHistory(7)).toEqual([])
  })
})
