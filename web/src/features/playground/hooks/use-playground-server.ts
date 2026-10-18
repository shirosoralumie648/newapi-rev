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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getServerErrorStatus,
  isServerErrorCancelled,
} from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  deletePlaygroundSession,
  getPlaygroundSessions,
  restorePlaygroundSession,
} from '../api'
import { playgroundQueryKeys } from '../lib/query-keys'
import {
  assertPlaygroundOwner,
  hydratePlaygroundWorkspace,
  playgroundSnapshot,
  savePlaygroundSession,
} from '../lib/server-sync'
import type { PlaygroundSyncedMessages } from '../lib/server-sync'
import type { PlaygroundSession, PlaygroundServerSession } from '../types'
import type { usePlaygroundState } from './use-playground-state'

type Operation =
  | { type: 'hydrate'; remote: PlaygroundServerSession[] }
  | { type: 'save'; draft: PlaygroundSession }
  | { type: 'delete'; id: string }
  | { type: 'restore'; id: string }

function readPendingDeletions(owner: number | null): string[] {
  if (owner === null) return []
  try {
    const data: unknown = JSON.parse(
      localStorage.getItem(`playground_pending_deletes:${owner}`) ?? '[]'
    )
    return Array.isArray(data)
      ? data.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

// Mount inside the account-keyed workspace. Network callbacks never cross that boundary.
export function usePlaygroundServer(
  local: ReturnType<typeof usePlaygroundState>,
  isGenerating: boolean
) {
  const owner = useAuthStore((state) => state.auth.user?.id ?? null)
  const queryClient = useQueryClient()
  const [ready, setReady] = useState(false)
  // A canceled mutation can settle without an observable isPending change, so
  // count settlements to re-evaluate pending work after every write.
  const [settleCount, setSettleCount] = useState(0)
  const [deleted, setDeleted] = useState(() => readPendingDeletions(owner))
  const [cacheError, setCacheError] = useState(false)
  const latest = useRef(local)
  const deletedRef = useRef(deleted)
  // Per canonical session id: what the last acknowledged write persisted, so a
  // save only sends the messages that changed. The hook is mounted per account,
  // and hydration rebuilds the entries from the server snapshot.
  const syncedMessages = useRef<PlaygroundSyncedMessages>(new Map())
  const requestRef = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const query = useQuery({
    queryKey: playgroundQueryKeys.list(owner),
    queryFn: ({ signal }) => getPlaygroundSessions(signal),
    enabled: owner !== null,
    retry: false,
    staleTime: Infinity,
    meta: { errorToast: false, keepPageOnInternalServerError: true },
  })

  useEffect(() => {
    latest.current = local
  }, [local])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = useAuthStore.subscribe((state) => {
      if ((state.auth.user?.id ?? null) !== owner) requestRef.current?.abort()
    })
    return () => {
      mounted.current = false
      requestRef.current?.abort()
      unsubscribe()
    }
  }, [owner])

  const rememberDeletions = (next: string[]) => {
    deletedRef.current = next
    setDeleted(next)
    try {
      localStorage.setItem(
        `playground_pending_deletes:${owner}`,
        JSON.stringify(next)
      )
    } catch {
      setCacheError(true)
    }
  }

  const mutation = useMutation({
    mutationFn: async (operation: Operation) => {
      if (owner === null) {
        throw new DOMException('Playground owner changed', 'AbortError')
      }
      const controller = new AbortController()
      requestRef.current = controller
      const signal = controller.signal
      assertPlaygroundOwner(owner, signal)
      if (operation.type === 'hydrate') {
        const drafts = latest.current.sessions
        // Preserve the pre-server workspace, without replacing a previous migration backup.
        try {
          const key = `playground_local_backup:${owner}`
          if (!localStorage.getItem(key)) {
            localStorage.setItem(
              key,
              JSON.stringify({
                activeSessionId: latest.current.activeSessionId,
                sessions: drafts,
              })
            )
          }
        } catch {
          setCacheError(true)
        }
        return hydratePlaygroundWorkspace(
          drafts,
          operation.remote,
          deletedRef.current,
          owner,
          signal,
          syncedMessages.current
        )
      }
      if (operation.type === 'delete') {
        try {
          await deletePlaygroundSession(operation.id, signal)
        } catch (error) {
          if (getServerErrorStatus(error) !== 404) throw error
        }
        assertPlaygroundOwner(owner, signal)
        syncedMessages.current.delete(operation.id)
        return null
      }
      if (operation.type === 'restore') {
        const restored = await restorePlaygroundSession(operation.id, signal)
        assertPlaygroundOwner(owner, signal)
        // Read the restored conversation exactly like a fresh hydration so the
        // next autosave compares against the stored messages, then re-join it
        // with the workspace the user currently sees.
        const hydrated = await hydratePlaygroundWorkspace(
          [],
          [restored],
          [],
          owner,
          signal,
          syncedMessages.current
        )
        const remaining = latest.current.sessions.filter(
          (session) =>
            session.id !== restored.id && session.server?.id !== restored.id
        )
        return [...remaining, ...hydrated]
      }
      await savePlaygroundSession(
        operation.draft,
        owner,
        signal,
        (server) => {
          if (!mounted.current) return
          latest.current.reconcileSession(operation.draft.id, (current) => ({
            ...current,
            server,
          }))
          // If the draft was deleted while creation was in flight, queue the new server ID.
          if (
            !latest.current.sessions.some(
              (session) => session.id === operation.draft.id
            )
          ) {
            rememberDeletions([...new Set([...deletedRef.current, server.id])])
          }
        },
        syncedMessages.current
      )
      assertPlaygroundOwner(owner, signal)
      return null
    },
    meta: { errorToast: false },
    retry: false,
    onSettled: () => {
      inFlight.current = false
      if (mounted.current) setSettleCount((count) => count + 1)
    },
    onSuccess: (sessions, operation) => {
      if (
        !mounted.current ||
        owner !== useAuthStore.getState().auth.user?.id ||
        requestRef.current?.signal.aborted
      ) {
        return
      }
      if (sessions) {
        latest.current.hydrateSessions(sessions)
        setReady(true)
      }
      if (operation.type === 'delete') {
        rememberDeletions(
          deletedRef.current.filter((id) => id !== operation.id)
        )
      }
      if (operation.type === 'restore') {
        // The conversation is alive again: a stale queued deletion must not
        // send it back to the trash.
        rememberDeletions(
          deletedRef.current.filter((id) => id !== operation.id)
        )
      }
      if (operation.type === 'save') {
        const snapshot = playgroundSnapshot(operation.draft)
        latest.current.reconcileSession(operation.draft.id, (current) => ({
          ...current,
          syncPending: playgroundSnapshot(current) !== snapshot,
        }))
      }
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.list(owner),
        refetchType: 'none',
      })
    },
  })
  const mutate = mutation.mutate
  const mutateAsync = mutation.mutateAsync
  const refetchSessions = query.refetch
  // A deliberate cancellation (unmount, owner change, superseded write) is not a
  // sync failure: keep the workspace state clean so the effects retry it.
  const surfacedError = (value: Error | null) =>
    value && !isServerErrorCancelled(value) ? value : null
  const error = surfacedError(mutation.error) ?? surfacedError(query.error)
  const isLoading = owner !== null && !ready && !error

  // React Query aborts a fetch whose signal the query function consumed when
  // the last observer unmounts (React StrictMode does that once after mount)
  // and does not retry the canceled request itself, so restart the list load.
  useEffect(() => {
    if (
      owner !== null &&
      query.data === undefined &&
      query.error &&
      isServerErrorCancelled(query.error)
    ) {
      void refetchSessions()
    }
  }, [owner, query.data, query.error, refetchSessions])

  useEffect(() => {
    if (
      owner === null ||
      local.isLoadingMessages ||
      ready ||
      !query.data ||
      mutation.isPending ||
      error
    ) {
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    mutate({ type: 'hydrate', remote: query.data })
  }, [
    owner,
    local.isLoadingMessages,
    ready,
    query.data,
    mutation.isPending,
    error,
    settleCount,
    mutate,
  ])

  useEffect(() => {
    if (!ready || isGenerating || mutation.isPending || error) return
    const removed = deleted[0]
    const draft = local.sessions.find(
      (session) => session.syncPending || !session.server
    )
    if (!removed && !draft) return
    const timer = window.setTimeout(() => {
      if (inFlight.current) return
      inFlight.current = true
      if (removed) mutate({ type: 'delete', id: removed })
      else if (draft) mutate({ type: 'save', draft })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    ready,
    isGenerating,
    mutation.isPending,
    error,
    settleCount,
    deleted,
    local.sessions,
    mutate,
  ])

  const retry = () => {
    mutation.reset()
    if (query.error) void query.refetch()
  }
  const conflict =
    getServerErrorStatus(error) === 409 ||
    error?.message ===
      'Playground changed on another device. Reload before saving.'
  const saveAsNew = () => {
    const operation = mutation.variables
    if (!conflict || operation?.type !== 'save' || isGenerating) return
    const replacementId = nanoid()
    // The failed snapshot is not the stored one any more: forget what the server
    // was believed to hold so the copy is created from the full local history.
    if (operation.draft.server) {
      syncedMessages.current.delete(operation.draft.server.id)
    }
    local.hydrateSessions(
      local.sessions.map((session) =>
        session.id === operation.draft.id
          ? {
              ...session,
              id: replacementId,
              server: undefined,
              syncPending: true,
            }
          : session
      )
    )
    mutation.reset()
  }
  const deleteSession = (id: string) => {
    const session = local.sessions.find((item) => item.id === id)
    if (session?.server) {
      rememberDeletions([
        ...new Set([...deletedRef.current, session.server.id]),
      ])
    }
    local.deleteSession(id)
  }
  // Restoring goes through the same mutation pipeline as saves and deletes, so
  // the refreshed workspace is applied by the mutation's success handler.
  const restoreSession = useCallback(
    async (id: string) => {
      await mutateAsync({ type: 'restore', id })
    },
    [mutateAsync]
  )
  // Attachment uploads need the canonical server session, so a send that
  // carries files creates the conversation first when it is still local-only.
  const ensureServerSession = useCallback(
    async (sessionId: string): Promise<PlaygroundSession> => {
      const session = local.findSession(sessionId)
      if (!session) {
        throw new Error('Playground session is not available')
      }
      if (session.server) return session
      await mutateAsync({ type: 'save', draft: session })
      const bound = local.findSession(sessionId)
      if (!bound?.server) {
        throw new Error('Playground session is not available')
      }
      return bound
    },
    [local, mutateAsync]
  )
  return {
    isLoading,
    isSaving: mutation.isPending,
    error,
    cacheError,
    retry,
    conflict,
    saveAsNew,
    deleteSession,
    restoreSession,
    ensureServerSession,
  }
}
