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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { useAuthStore } from '@/stores/auth-store'

import { PLAYGROUND_INPUT_DRAFT_DEBOUNCE_MS } from '../constants'
import {
  loadComposerDrafts,
  loadComposerHistory,
  rememberComposerHistoryEntry,
  saveComposerDraft,
} from '../lib/input/composer-memory-storage'

/**
 * The composer text plus its browser-owned memory. The draft of one
 * conversation is restored when the workspace reloads or the active
 * conversation changes, and ArrowUp/ArrowDown recall the account's input
 * history (shared across conversations). Everything here is local to the
 * browser; the conversation itself stays owned by the stored session state and
 * the server.
 */
export function usePlaygroundComposerMemory(
  sessionId: string | null | undefined
) {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [text, setText] = useState('')

  const textRef = useRef('')
  const userIdRef = useRef<number | null>(userId)
  const accountRef = useRef<number | null>(userId)
  const draftsRef = useRef<Map<string, string> | null>(null)
  const historyRef = useRef<string[]>([])
  // null while the composer shows what the user typed; otherwise the index of
  // the recalled history entry.
  const navigationIndexRef = useRef<number | null>(null)
  // The text that was in the composer before history navigation started, so
  // ArrowDown past the newest entry restores it.
  const stagedTextRef = useRef('')
  const activeSessionRef = useRef<string | null>(sessionId ?? null)
  const saveTimerRef = useRef<number | null>(null)

  // Load the account's drafts and history. Changing accounts re-reads the
  // scoped storage before any conversation switch is evaluated, and flushes the
  // previous account's draft under its own key first.
  useEffect(() => {
    const previousUserId = accountRef.current
    const previousSessionId = activeSessionRef.current
    if (previousUserId !== userId) {
      if (previousSessionId && previousUserId !== null) {
        saveComposerDraft(previousUserId, previousSessionId, textRef.current)
      }
      accountRef.current = userId
    }
    userIdRef.current = userId
    draftsRef.current = loadComposerDrafts(userId)
    historyRef.current = loadComposerHistory(userId)
    navigationIndexRef.current = null
    const draft = activeSessionRef.current
      ? (draftsRef.current.get(activeSessionRef.current) ?? '')
      : ''
    textRef.current = draft
    // Auth changes intentionally rehydrate browser-owned data after hiding the
    // previous account's copy.
    // eslint-disable-next-line react/set-state-in-effect
    setText(draft)
  }, [userId])

  // Switching conversations flushes the previous draft and restores the next.
  useEffect(() => {
    const nextSessionId = sessionId ?? null
    const previousSessionId = activeSessionRef.current
    if (previousSessionId === nextSessionId) return
    activeSessionRef.current = nextSessionId
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const previousUserId = accountRef.current
    accountRef.current = userIdRef.current
    if (previousSessionId && previousUserId === userIdRef.current) {
      saveComposerDraft(userIdRef.current, previousSessionId, textRef.current)
    }
    navigationIndexRef.current = null
    const drafts = draftsRef.current ?? loadComposerDrafts(userIdRef.current)
    draftsRef.current = drafts
    const draft = nextSessionId ? (drafts.get(nextSessionId) ?? '') : ''
    textRef.current = draft
    // eslint-disable-next-line react/set-state-in-effect
    setText(draft)
  }, [sessionId])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const sessionIdValue = activeSessionRef.current
      if (sessionIdValue) {
        saveComposerDraft(userIdRef.current, sessionIdValue, textRef.current)
      }
    },
    []
  )

  const scheduleDraftSave = useCallback(() => {
    const sessionIdValue = activeSessionRef.current
    if (!sessionIdValue) return
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      saveComposerDraft(userIdRef.current, sessionIdValue, textRef.current)
    }, PLAYGROUND_INPUT_DRAFT_DEBOUNCE_MS)
  }, [])

  const updateText = useCallback(
    (value: string) => {
      navigationIndexRef.current = null
      textRef.current = value
      setText(value)
      scheduleDraftSave()
    },
    [scheduleDraftSave]
  )

  const appendText = useCallback(
    (addition: string) => {
      const current = textRef.current
      updateText(current ? `${current}\n\n${addition}` : addition)
    },
    [updateText]
  )

  /** Records one successfully sent text; a failed send keeps the history. */
  const rememberSubmittedText = useCallback((value: string) => {
    historyRef.current = rememberComposerHistoryEntry(userIdRef.current, value)
    navigationIndexRef.current = null
  }, [])

  const recallHistoryEntry = useCallback(
    (index: number) => {
      const value = historyRef.current[index]
      navigationIndexRef.current = index
      textRef.current = value
      setText(value)
      scheduleDraftSave()
    },
    [scheduleDraftSave]
  )

  /**
   * ArrowUp recalls older inputs from an empty composer (or while already
   * recalling) and ArrowDown returns to newer ones, restoring the draft being
   * typed when it moves past the newest entry. Escape leaves the recalled text
   * in place and stops navigating.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const navigation = navigationIndexRef.current
      if (event.key === 'ArrowUp') {
        const caretAtStart =
          event.currentTarget.selectionStart === 0 &&
          event.currentTarget.selectionEnd === 0
        if (navigation === null && !caretAtStart) return
        if (navigation === null && event.currentTarget.value !== '') return
        const history = historyRef.current
        if (history.length === 0) return
        event.preventDefault()
        if (navigation === null) stagedTextRef.current = textRef.current
        recallHistoryEntry(
          navigation === null ? 0 : Math.min(navigation + 1, history.length - 1)
        )
        return
      }
      if (event.key === 'ArrowDown' && navigation !== null) {
        event.preventDefault()
        if (navigation === 0) {
          navigationIndexRef.current = null
          const restored = stagedTextRef.current
          textRef.current = restored
          setText(restored)
          scheduleDraftSave()
          return
        }
        recallHistoryEntry(navigation - 1)
        return
      }
      if (event.key === 'Escape' && navigation !== null) {
        navigationIndexRef.current = null
      }
    },
    [recallHistoryEntry, scheduleDraftSave]
  )

  return {
    text,
    updateText,
    appendText,
    handleKeyDown,
    rememberSubmittedText,
  }
}
