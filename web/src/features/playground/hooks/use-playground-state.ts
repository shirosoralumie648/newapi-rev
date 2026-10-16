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

import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../constants'
import {
  applyMessageStateUpdate,
  type MessageStateUpdater,
} from '../lib/state/playground-state-utils'
import { loadLegacyPlaygroundState } from '../lib/storage/storage'
import {
  createEmptySession,
  loadSessionsState,
  saveSessionsState,
} from '../session-storage'
import type {
  GroupOption,
  ModelOption,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundSession,
} from '../types'

const SESSION_SAVE_DEBOUNCE_MS = 500

type SessionUpdate = (session: PlaygroundSession) => PlaygroundSession

type SessionStateUpdate = (
  sessions: PlaygroundSession[],
  activeSessionId: string
) => void

type MessageUpdate = (
  updater: MessageStateUpdater,
  sessionId?: string | null
) => void

export function usePlaygroundState() {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [persistenceError, setPersistenceError] = useState(false)
  const [sessions, setSessions] = useState<PlaygroundSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [hydratedUserId, setHydratedUserId] = useState<
    number | null | undefined
  >(undefined)
  const [models, setModels] = useState<ModelOption[]>([])
  const [groups, setGroups] = useState<GroupOption[]>([])
  const saveTimerRef = useRef<number | null>(null)
  const latestSessionsRef = useRef<PlaygroundSession[]>([])
  const latestActiveSessionIdRef = useRef<string | null>(null)
  const latestUserIdRef = useRef<number | null>(userId)
  const hasLoadedSessionsRef = useRef(false)

  const isHydrated = hydratedUserId === userId
  const visibleSessions = isHydrated ? sessions : []
  const activeSession =
    visibleSessions.find((session) => session.id === activeSessionId) ??
    visibleSessions[0]

  const persistSessions = useCallback(
    (nextSessions: PlaygroundSession[], nextActiveSessionId: string) => {
      latestSessionsRef.current = nextSessions
      latestActiveSessionIdRef.current = nextActiveSessionId

      if (!hasLoadedSessionsRef.current) return

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }

      const ownerId = latestUserIdRef.current
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null
        if (
          latestUserIdRef.current !== ownerId ||
          latestActiveSessionIdRef.current === null
        ) {
          return
        }
        const saved = saveSessionsState(
          {
            activeSessionId: latestActiveSessionIdRef.current,
            sessions: latestSessionsRef.current,
          },
          ownerId
        )
        if (ownerId !== null) setPersistenceError(!saved)
      }, SESSION_SAVE_DEBOUNCE_MS)
    },
    []
  )

  const applySessionState = useCallback<SessionStateUpdate>(
    (nextSessions, nextActiveSessionId) => {
      latestSessionsRef.current = nextSessions
      latestActiveSessionIdRef.current = nextActiveSessionId
      setSessions(nextSessions)
      setActiveSessionId(nextActiveSessionId)
      persistSessions(nextSessions, nextActiveSessionId)
    },
    [persistSessions]
  )

  useEffect(() => {
    if (
      hydratedUserId !== undefined &&
      latestUserIdRef.current !== userId &&
      latestActiveSessionIdRef.current !== null
    ) {
      saveSessionsState(
        {
          activeSessionId: latestActiveSessionIdRef.current,
          sessions: latestSessionsRef.current,
        },
        latestUserIdRef.current
      )
    }

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    latestUserIdRef.current = userId
    hasLoadedSessionsRef.current = false
    const legacy = loadLegacyPlaygroundState(userId)
    const loaded = loadSessionsState(
      {
        config: { ...DEFAULT_CONFIG, ...legacy.config },
        parameterEnabled: {
          ...DEFAULT_PARAMETER_ENABLED,
          ...legacy.parameterEnabled,
        },
        messages: legacy.messages ?? [],
      },
      userId
    )

    latestSessionsRef.current = loaded.sessions
    latestActiveSessionIdRef.current = loaded.activeSessionId
    // eslint-disable-next-line react/set-state-in-effect
    setSessions(loaded.sessions)
    // eslint-disable-next-line react/set-state-in-effect
    setActiveSessionId(loaded.activeSessionId)
    hasLoadedSessionsRef.current = true
    // Auth changes intentionally rehydrate browser-owned data after hiding the old owner.
    // eslint-disable-next-line react/set-state-in-effect
    setHydratedUserId(userId)
  }, [hydratedUserId, userId])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }

      if (latestActiveSessionIdRef.current !== null) {
        saveSessionsState(
          {
            activeSessionId: latestActiveSessionIdRef.current,
            sessions: latestSessionsRef.current,
          },
          latestUserIdRef.current
        )
      }
    },
    []
  )

  const hydrateSessions = useCallback(
    (nextSessions: PlaygroundSession[]) => {
      if (
        latestUserIdRef.current !==
        (useAuthStore.getState().auth.user?.id ?? null)
      ) {
        return
      }
      const sessionsToUse = nextSessions.length
        ? nextSessions
        : [createEmptySession(DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED)]
      const currentId = latestActiveSessionIdRef.current
      const activeId =
        sessionsToUse.find((session) => session.id === currentId)?.id ??
        sessionsToUse[0].id
      applySessionState(sessionsToUse, activeId)
    },
    [applySessionState]
  )

  const reconcileSession = useCallback(
    (id: string, updater: SessionUpdate) => {
      if (
        latestUserIdRef.current !==
        (useAuthStore.getState().auth.user?.id ?? null)
      ) {
        return
      }
      const activeId = latestActiveSessionIdRef.current
      if (!activeId) return
      const next = latestSessionsRef.current.map((session) =>
        session.id === id ? updater(session) : session
      )
      applySessionState(next, activeId)
    },
    [applySessionState]
  )

  const updateSession = useCallback(
    (sessionId: string, updater: SessionUpdate) => {
      reconcileSession(sessionId, (session) => ({
        ...updater(session),
        syncPending: true,
        updatedAt: Date.now(),
      }))
    },
    [reconcileSession]
  )

  const updateConfig = useCallback(
    <K extends keyof PlaygroundConfig>(key: K, value: PlaygroundConfig[K]) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        config: { ...session.config, [key]: value },
      }))
    },
    [updateSession]
  )

  const updateParameterEnabled = useCallback(
    (key: keyof ParameterEnabled, value: boolean) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        parameterEnabled: { ...session.parameterEnabled, [key]: value },
      }))
    },
    [updateSession]
  )

  const updateMessages = useCallback<MessageUpdate>(
    (updater, sessionId = latestActiveSessionIdRef.current) => {
      if (!sessionId) return

      updateSession(sessionId, (session) => ({
        ...session,
        messages: applyMessageStateUpdate(session.messages, updater),
      }))
    },
    [updateSession]
  )

  const clearMessages = useCallback(() => updateMessages([]), [updateMessages])

  const createSession = useCallback(() => {
    const currentSession = latestSessionsRef.current.find(
      (session) => session.id === latestActiveSessionIdRef.current
    )
    const nextSession = createEmptySession(
      currentSession?.config ?? DEFAULT_CONFIG,
      currentSession?.parameterEnabled ?? DEFAULT_PARAMETER_ENABLED
    )
    const nextSessions = [
      { ...nextSession, syncPending: true },
      ...latestSessionsRef.current,
    ]
    applySessionState(nextSessions, nextSession.id)
  }, [applySessionState])

  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      const normalizedTitle = title.trim()
      if (!normalizedTitle) return
      updateSession(sessionId, (session) => ({
        ...session,
        title: normalizedTitle,
      }))
    },
    [updateSession]
  )

  const deleteSession = useCallback(
    (sessionId: string) => {
      const remaining = latestSessionsRef.current.filter(
        (session) => session.id !== sessionId
      )
      const currentSession = latestSessionsRef.current.find(
        (session) => session.id === sessionId
      )
      const fallback =
        remaining[0] ??
        createEmptySession(
          currentSession?.config ?? DEFAULT_CONFIG,
          currentSession?.parameterEnabled ?? DEFAULT_PARAMETER_ENABLED
        )
      const nextSessions = remaining.length > 0 ? remaining : [fallback]
      const nextActiveSessionId =
        latestActiveSessionIdRef.current === sessionId
          ? nextSessions[0].id
          : (latestActiveSessionIdRef.current ?? nextSessions[0].id)
      applySessionState(nextSessions, nextActiveSessionId)
    },
    [applySessionState]
  )

  const switchSession = useCallback(
    (sessionId: string) => {
      if (
        !latestSessionsRef.current.some((session) => session.id === sessionId)
      ) {
        return
      }
      applySessionState(latestSessionsRef.current, sessionId)
    },
    [applySessionState]
  )

  const resetConfig = useCallback(() => {
    const currentActiveSessionId = latestActiveSessionIdRef.current
    if (!currentActiveSessionId) return

    updateSession(currentActiveSessionId, (session) => ({
      ...session,
      config: { ...DEFAULT_CONFIG },
      parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED },
    }))
  }, [updateSession])

  return {
    config: activeSession?.config ?? DEFAULT_CONFIG,
    parameterEnabled:
      activeSession?.parameterEnabled ?? DEFAULT_PARAMETER_ENABLED,
    messages: activeSession?.messages ?? [],
    isLoadingMessages: !isHydrated,
    models,
    groups,
    sessions: visibleSessions,
    persistenceError,
    activeSessionId: activeSession?.id ?? null,
    setModels,
    setGroups,
    updateConfig,
    updateParameterEnabled,
    updateMessages,
    clearMessages,
    resetConfig,
    hydrateSessions,
    reconcileSession,
    createSession,
    renameSession,
    deleteSession,
    switchSession,
  }
}
