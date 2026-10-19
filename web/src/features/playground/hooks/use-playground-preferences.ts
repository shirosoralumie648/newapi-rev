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
import { useCallback, useEffect, useState } from 'react'

import {
  loadAutoReadPreferences,
  loadAutoTitlePreferences,
  saveAutoReadPreferences,
  saveAutoTitlePreferences,
  type PlaygroundAutoReadPreferences,
  type PlaygroundAutoTitlePreferences,
} from '../lib/storage/playground-preferences'

/**
 * Account-level Playground preferences that stay in the browser: the auto
 * read-aloud and automatic conversation naming defaults plus one explicit
 * override per conversation. An account default applies to every conversation
 * without an override and to every new conversation.
 */
export function usePlaygroundPreferences(userId: number | null) {
  const [autoRead, setAutoRead] = useState<PlaygroundAutoReadPreferences>({
    defaultEnabled: false,
    overrides: {},
  })
  const [autoTitle, setAutoTitle] = useState<PlaygroundAutoTitlePreferences>({
    defaultEnabled: true,
    overrides: {},
  })

  // Auth changes intentionally rehydrate browser-owned preferences after
  // hiding the previous account's state.
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    setAutoRead(loadAutoReadPreferences(userId))
    // eslint-disable-next-line react/set-state-in-effect
    setAutoTitle(loadAutoTitlePreferences(userId))
  }, [userId])

  const persistAutoRead = useCallback(
    (next: PlaygroundAutoReadPreferences) => {
      setAutoRead(next)
      saveAutoReadPreferences(userId, next)
    },
    [userId]
  )

  const persistAutoTitle = useCallback(
    (next: PlaygroundAutoTitlePreferences) => {
      setAutoTitle(next)
      saveAutoTitlePreferences(userId, next)
    },
    [userId]
  )

  const setAutoReadDefault = useCallback(
    (value: boolean) => {
      persistAutoRead({ ...autoRead, defaultEnabled: value })
    },
    [persistAutoRead, autoRead]
  )

  /** Set one conversation's override; null removes it and follows the default. */
  const setSessionAutoRead = useCallback(
    (sessionId: string | null, value: boolean | null) => {
      if (!sessionId) return
      const overrides = { ...autoRead.overrides }
      if (value === null) {
        delete overrides[sessionId]
      } else {
        overrides[sessionId] = value
      }
      persistAutoRead({ ...autoRead, overrides })
    },
    [persistAutoRead, autoRead]
  )

  const isAutoReadEnabled = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) return autoRead.defaultEnabled
      return autoRead.overrides[sessionId] ?? autoRead.defaultEnabled
    },
    [autoRead]
  )

  const hasSessionAutoReadOverride = useCallback(
    (sessionId: string | null) =>
      Boolean(sessionId && sessionId in autoRead.overrides),
    [autoRead]
  )

  const setAutoTitleDefault = useCallback(
    (value: boolean) => {
      persistAutoTitle({ ...autoTitle, defaultEnabled: value })
    },
    [persistAutoTitle, autoTitle]
  )

  /** Set one conversation's override; null removes it and follows the default. */
  const setSessionAutoTitle = useCallback(
    (sessionId: string | null, value: boolean | null) => {
      if (!sessionId) return
      const overrides = { ...autoTitle.overrides }
      if (value === null) {
        delete overrides[sessionId]
      } else {
        overrides[sessionId] = value
      }
      persistAutoTitle({ ...autoTitle, overrides })
    },
    [persistAutoTitle, autoTitle]
  )

  const isAutoTitleEnabled = useCallback(
    (sessionId: string | null) => {
      if (!sessionId) return autoTitle.defaultEnabled
      return autoTitle.overrides[sessionId] ?? autoTitle.defaultEnabled
    },
    [autoTitle]
  )

  const hasSessionAutoTitleOverride = useCallback(
    (sessionId: string | null) =>
      Boolean(sessionId && sessionId in autoTitle.overrides),
    [autoTitle]
  )

  return {
    autoReadDefault: autoRead.defaultEnabled,
    hasSessionAutoReadOverride,
    isAutoReadEnabled,
    setAutoReadDefault,
    setSessionAutoRead,
    autoTitleDefault: autoTitle.defaultEnabled,
    hasSessionAutoTitleOverride,
    isAutoTitleEnabled,
    setAutoTitleDefault,
    setSessionAutoTitle,
  }
}
