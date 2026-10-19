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

import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_DEVELOPER_OPTIONS,
  DEFAULT_PARAMETER_ENABLED,
} from '../constants'
import { modelCatalogDefaultConfig } from '../lib/model-catalog'
import { normalizeSessionTags } from '../lib/session-organization'
import {
  applyMessageStateUpdate,
  type MessageStateUpdater,
} from '../lib/state/playground-state-utils'
import {
  loadNewSessionDefaults,
  saveNewSessionDefaults,
  type PlaygroundNewSessionDefaults,
} from '../lib/storage/playground-preferences'
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
  PlaygroundContextSettings,
  PlaygroundContextSummary,
  PlaygroundDeveloperOptions,
  PlaygroundModelCatalogDefaults,
  PlaygroundSession,
  PlaygroundSessionOrganization,
} from '../types'

const SESSION_SAVE_DEBOUNCE_MS = 500
// The account-level new-conversation defaults are written after the active
// conversation settles, so dragging a slider does not write on every frame.
const NEW_SESSION_DEFAULTS_DEBOUNCE_MS = 400

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
  const newSessionDefaultsTimerRef = useRef<number | null>(null)
  const latestSessionsRef = useRef<PlaygroundSession[]>([])
  const latestActiveSessionIdRef = useRef<string | null>(null)
  const latestUserIdRef = useRef<number | null>(userId)
  const hasLoadedSessionsRef = useRef(false)
  // The account's remembered new-conversation starting point. Persisted per
  // account in the browser; the server sessions stay the source of truth for
  // the conversations themselves.
  const newSessionDefaultsRef = useRef<PlaygroundNewSessionDefaults | null>(
    null
  )

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
    if (newSessionDefaultsTimerRef.current !== null) {
      window.clearTimeout(newSessionDefaultsTimerRef.current)
      newSessionDefaultsTimerRef.current = null
    }

    latestUserIdRef.current = userId
    hasLoadedSessionsRef.current = false
    const legacy = loadLegacyPlaygroundState(userId)
    const defaults = loadNewSessionDefaults(userId)
    newSessionDefaultsRef.current = defaults
    const loaded = loadSessionsState(
      {
        config: { ...DEFAULT_CONFIG, ...legacy.config },
        parameterEnabled: {
          ...DEFAULT_PARAMETER_ENABLED,
          ...legacy.parameterEnabled,
        },
        messages: legacy.messages ?? [],
      },
      userId,
      defaults
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
      if (newSessionDefaultsTimerRef.current !== null) {
        window.clearTimeout(newSessionDefaultsTimerRef.current)
        newSessionDefaultsTimerRef.current = null
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

  // Remember the account's latest model, parameters and system prompt as the
  // starting point of the next new conversation. Switching conversations also
  // refreshes the defaults, so "recently used" is exactly what the account
  // last worked with.
  const activeConfig = isHydrated ? activeSession?.config : undefined
  const activeParameterEnabled = isHydrated
    ? activeSession?.parameterEnabled
    : undefined
  const activeSystemPrompt = activeSession?.systemPrompt
  useEffect(() => {
    if (!isHydrated || !activeConfig || !activeParameterEnabled) return
    const nextDefaults: PlaygroundNewSessionDefaults = {
      config: activeConfig,
      parameterEnabled: activeParameterEnabled,
      systemPrompt: activeSystemPrompt ?? '',
    }
    const current = newSessionDefaultsRef.current
    if (
      current &&
      JSON.stringify(current.config) === JSON.stringify(nextDefaults.config) &&
      JSON.stringify(current.parameterEnabled) ===
        JSON.stringify(nextDefaults.parameterEnabled) &&
      current.systemPrompt === nextDefaults.systemPrompt
    ) {
      return
    }

    // The in-memory defaults update immediately so creating a conversation
    // right after a change uses it; only the browser write is debounced.
    newSessionDefaultsRef.current = nextDefaults
    if (newSessionDefaultsTimerRef.current !== null) {
      window.clearTimeout(newSessionDefaultsTimerRef.current)
    }
    const ownerId = userId
    newSessionDefaultsTimerRef.current = window.setTimeout(() => {
      newSessionDefaultsTimerRef.current = null
      if (latestUserIdRef.current !== ownerId) return
      saveNewSessionDefaults(ownerId, nextDefaults)
    }, NEW_SESSION_DEFAULTS_DEBOUNCE_MS)
  }, [
    activeConfig,
    activeParameterEnabled,
    activeSystemPrompt,
    isHydrated,
    userId,
  ])

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

  const updateSystemPrompt = useCallback(
    (value: string) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        systemPrompt: value,
      }))
    },
    [updateSession]
  )

  const updateContextSettings = useCallback(
    (settings: PlaygroundContextSettings) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        context: { ...settings },
      }))
    },
    [updateSession]
  )

  const updateContextSummary = useCallback(
    (summary: PlaygroundContextSummary | null) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        contextSummary: summary,
      }))
    },
    [updateSession]
  )

  const updateKnowledgeBaseIds = useCallback(
    (knowledgeBaseIds: string[]) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        knowledgeBaseIds: [...knowledgeBaseIds],
      }))
    },
    [updateSession]
  )

  // The stored developer settings replace the previous object as a whole, so
  // the value is copied one level deeper than the others: the tools list and
  // every function object stay independent of the caller's object.
  const updateDeveloperOptions = useCallback(
    (options: PlaygroundDeveloperOptions) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        developerOptions: {
          ...options,
          tools: options.tools.map((tool) => ({
            ...tool,
            function: { ...tool.function },
          })),
        },
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

  /**
   * Applies a complete settings bundle (for example an assistant preset) to the
   * active conversation, replacing configuration, parameter flags and prompt in
   * one write so a sync save observes a consistent snapshot.
   */
  const applySessionSettings = useCallback(
    (settings: {
      config: PlaygroundConfig
      parameterEnabled: ParameterEnabled
      systemPrompt: string
      openingMessage: string
      suggestedQuestions: string[]
    }) => {
      const currentActiveSessionId = latestActiveSessionIdRef.current
      if (!currentActiveSessionId) return

      updateSession(currentActiveSessionId, (session) => ({
        ...session,
        ...settings,
      }))
    },
    [updateSession]
  )

  /**
   * Creates a conversation. A caller may pass the settings a preset supplies;
   * otherwise the new conversation starts from the account's remembered
   * defaults (latest model, parameters and system prompt), falling back to the
   * active one's configuration and finally to the factory defaults.
   */
  const createSession = useCallback(
    (overrides?: {
      config?: PlaygroundConfig
      parameterEnabled?: ParameterEnabled
      /** Model of the new conversation, overriding the remembered value. */
      model?: string
      /**
       * Curated defaults of that model. They apply only while this session is
       * created; switching models later or reopening an existing conversation
       * never re-applies them.
       */
      modelDefaults?: PlaygroundModelCatalogDefaults
      systemPrompt?: string
      openingMessage?: string
      suggestedQuestions?: string[]
      knowledgeBaseIds?: string[]
    }) => {
      const currentSession = latestSessionsRef.current.find(
        (session) => session.id === latestActiveSessionIdRef.current
      )
      const defaults = newSessionDefaultsRef.current
      // An explicit config (a preset or a replay draft) already states every
      // sampling value, so its choices win over an entry's catalog defaults.
      const catalogDefaults = overrides?.config
        ? null
        : modelCatalogDefaultConfig(overrides?.modelDefaults)
      const baseConfig =
        overrides?.config ??
        defaults?.config ??
        currentSession?.config ??
        DEFAULT_CONFIG
      const nextSession = createEmptySession(
        {
          ...baseConfig,
          ...(catalogDefaults?.config ?? {}),
          model: overrides?.model ?? baseConfig.model,
        },
        {
          ...(overrides?.parameterEnabled ??
            defaults?.parameterEnabled ??
            currentSession?.parameterEnabled ??
            DEFAULT_PARAMETER_ENABLED),
          ...(catalogDefaults?.parameterEnabled ?? {}),
        },
        overrides?.systemPrompt ?? defaults?.systemPrompt ?? '',
        DEFAULT_CONTEXT_SETTINGS,
        null,
        overrides?.openingMessage ?? '',
        overrides?.suggestedQuestions ?? [],
        overrides?.knowledgeBaseIds ?? []
      )
      const nextSessions = [
        { ...nextSession, syncPending: true },
        ...latestSessionsRef.current,
      ]
      applySessionState(nextSessions, nextSession.id)
    },
    [applySessionState]
  )

  /**
   * Adds a conversation that already exists on the server (a completed import).
   * Its messages are acknowledged by the caller, so it is not marked pending.
   */
  const addSession = useCallback(
    (session: PlaygroundSession) => {
      const serverId = session.server?.id
      const nextSessions = [
        session,
        ...latestSessionsRef.current.filter(
          (item) =>
            item.id !== session.id &&
            (!serverId || item.server?.id !== serverId)
        ),
      ]
      applySessionState(nextSessions, session.id)
    },
    [applySessionState]
  )

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

  /**
   * Applies pin, archive and tag changes to one conversation, not necessarily
   * the active one. Archiving always clears the pin so the client groups stay
   * unambiguous; tags are normalized before they reach local storage.
   */
  const organizeSession = useCallback(
    (sessionId: string, organization: PlaygroundSessionOrganization) => {
      updateSession(sessionId, (session) => {
        const archived = organization.archived ?? session.archived
        const pinned = archived
          ? false
          : (organization.pinned ?? session.pinned)
        return {
          ...session,
          pinned,
          archived,
          tags:
            organization.tags === undefined
              ? session.tags
              : normalizeSessionTags(organization.tags),
        }
      })
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
          currentSession?.parameterEnabled ?? DEFAULT_PARAMETER_ENABLED,
          currentSession?.systemPrompt ?? '',
          currentSession?.context
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

  // Reads the newest session state without waiting for a render, so callers
  // that await server work mid-flow observe acknowledgements immediately.
  const findSession = useCallback(
    (sessionId: string) =>
      latestSessionsRef.current.find((session) => session.id === sessionId),
    []
  )

  return {
    config: activeSession?.config ?? DEFAULT_CONFIG,
    parameterEnabled:
      activeSession?.parameterEnabled ?? DEFAULT_PARAMETER_ENABLED,
    systemPrompt: activeSession?.systemPrompt ?? '',
    openingMessage: activeSession?.openingMessage ?? '',
    suggestedQuestions: activeSession?.suggestedQuestions ?? [],
    context: activeSession?.context ?? DEFAULT_CONTEXT_SETTINGS,
    contextSummary: activeSession?.contextSummary ?? null,
    developerOptions:
      activeSession?.developerOptions ?? DEFAULT_DEVELOPER_OPTIONS,
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
    updateSystemPrompt,
    updateContextSettings,
    updateContextSummary,
    updateKnowledgeBaseIds,
    updateDeveloperOptions,
    applySessionSettings,
    updateMessages,
    clearMessages,
    resetConfig,
    hydrateSessions,
    reconcileSession,
    findSession,
    createSession,
    addSession,
    renameSession,
    organizeSession,
    deleteSession,
    switchSession,
  }
}
