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
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import {
  rememberComposerHistoryEntry,
  saveComposerDraft,
  loadComposerDrafts,
} from '../../lib/input/composer-memory-storage'
import { usePlaygroundComposerMemory } from '../use-playground-composer-memory'

function ComposerHarness(props: { sessionId: string | null }) {
  const composer = usePlaygroundComposerMemory(props.sessionId)
  return (
    <textarea
      aria-label='composer'
      onChange={(event) => composer.updateText(event.target.value)}
      onKeyDown={composer.handleKeyDown}
      value={composer.text}
    />
  )
}

const textarea = () => screen.getByRole('textbox', { name: 'composer' })

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.reset()
})

afterEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.reset()
})

test('restores the draft of the active conversation on mount', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  saveComposerDraft(7, 'session-a', 'Unfinished thought')

  render(<ComposerHarness sessionId='session-a' />)

  expect(textarea()).toHaveValue('Unfinished thought')
})

test('ArrowUp recalls older inputs and ArrowDown returns to the typed draft', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  rememberComposerHistoryEntry(7, 'first prompt')
  rememberComposerHistoryEntry(7, 'second prompt')

  render(<ComposerHarness sessionId='session-a' />)

  fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
  expect(textarea()).toHaveValue('second prompt')

  fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
  expect(textarea()).toHaveValue('first prompt')

  fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
  expect(textarea()).toHaveValue('second prompt')

  // Moving past the newest entry restores what was being typed before.
  fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
  expect(textarea()).toHaveValue('')
})

test('a failed recall keeps the composer untouched when history is empty', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })

  render(<ComposerHarness sessionId='session-a' />)
  fireEvent.keyDown(textarea(), { key: 'ArrowUp' })

  expect(textarea()).toHaveValue('')
})

test('typing after a recall stops history navigation', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  rememberComposerHistoryEntry(7, 'recalled prompt')

  render(<ComposerHarness sessionId='session-a' />)

  fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
  expect(textarea()).toHaveValue('recalled prompt')

  fireEvent.change(textarea(), { target: { value: 'recalled prompt edited' } })
  fireEvent.keyDown(textarea(), { key: 'ArrowDown' })

  expect(textarea()).toHaveValue('recalled prompt edited')
})

test('ArrowUp does not replace text the user is already typing', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  rememberComposerHistoryEntry(7, 'older prompt')

  render(<ComposerHarness sessionId='session-a' />)

  fireEvent.change(textarea(), { target: { value: 'typed text' } })
  fireEvent.keyDown(textarea(), { key: 'ArrowUp' })

  expect(textarea()).toHaveValue('typed text')
})

test('switching conversations saves the previous draft and restores the next', () => {
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
  saveComposerDraft(7, 'session-b', 'Draft B')

  const view = render(<ComposerHarness sessionId='session-a' />)
  fireEvent.change(textarea(), { target: { value: 'Draft A' } })

  view.rerender(<ComposerHarness sessionId='session-b' />)
  expect(textarea()).toHaveValue('Draft B')
  expect(loadComposerDrafts(7).get('session-a')).toBe('Draft A')

  view.rerender(<ComposerHarness sessionId='session-a' />)
  expect(textarea()).toHaveValue('Draft A')
})
