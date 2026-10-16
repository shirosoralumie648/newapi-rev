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
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

import { getServerErrorStatus } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  createPlaygroundArtifact,
  deletePlaygroundArtifact,
  getPlaygroundArtifact,
  listPlaygroundArtifacts,
  listPlaygroundArtifactVersions,
  restorePlaygroundArtifactVersion,
  savePlaygroundArtifactVersion,
  type CreatePlaygroundArtifactRequest,
  type PlaygroundArtifactKind,
  type PlaygroundArtifactResult,
  type PlaygroundArtifactVersionMetadata,
  type SavePlaygroundArtifactRequest,
} from '../artifact-api'
import { playgroundQueryKeys } from '../lib/query-keys'

export interface ArtifactDraft {
  kind: PlaygroundArtifactKind
  title: string
  language: string
  content: string
}

export interface CapturedArtifactSource {
  ownerId: number
  sessionId: string
  messageKey: string
  versionId: string
  messageRevision: number
  rawContent: string
  visibleContent: string
}

interface ArtifactEditorState {
  sessionScope: string
  isOpen: boolean
  selectedArtifactId: string | null
  selectedVersionId: string | null
  draft: ArtifactDraft | null
  baseRevision: number | null
  dirty: boolean
  pendingCreate: CreatePlaygroundArtifactRequest | null
  pendingSave: SavePlaygroundArtifactRequest | null
  pendingSaveSnapshot: ArtifactDraft | null
  pendingRestore: {
    requestId: string
    revision: number
    versionId: string
  } | null
  pendingDelete: { artifactId: string; revision: number } | null
  navigationAfterDiscard: (() => void) | null
  showDiscardConfirmation: boolean
  setOpen: (isOpen: boolean) => void
  selectArtifact: (artifactId: string | null) => void
  selectVersion: (versionId: string | null) => void
  updateDraft: (draft: ArtifactDraft) => void
  hydrateDraft: (result: PlaygroundArtifactResult) => void
  acknowledgeSave: (
    result: PlaygroundArtifactResult,
    saved: ArtifactDraft
  ) => void
  setPendingCreate: (request: CreatePlaygroundArtifactRequest | null) => void
  setPendingSave: (
    request: SavePlaygroundArtifactRequest | null,
    snapshot?: ArtifactDraft | null
  ) => void
  setPendingRestore: (
    request: { requestId: string; revision: number; versionId: string } | null
  ) => void
  setPendingDelete: (
    request: { artifactId: string; revision: number } | null
  ) => void
  requestDiscard: (action: () => void) => void
  discardAndContinue: () => void
  cancelDiscard: () => void
  resetForSession: (scope: string) => void
}

function makeArtifactEditorStore(sessionScope: string) {
  return createStore<ArtifactEditorState>()((set, get) => ({
    sessionScope,
    isOpen: false,
    selectedArtifactId: null,
    selectedVersionId: null,
    draft: null,
    baseRevision: null,
    dirty: false,
    pendingCreate: null,
    pendingSave: null,
    pendingSaveSnapshot: null,
    pendingRestore: null,
    pendingDelete: null,
    navigationAfterDiscard: null,
    showDiscardConfirmation: false,
    setOpen: (isOpen) => set({ isOpen }),
    selectArtifact: (selectedArtifactId) =>
      set((current) =>
        selectedArtifactId === current.selectedArtifactId
          ? { selectedVersionId: null }
          : {
              selectedArtifactId,
              selectedVersionId: null,
              draft: null,
              baseRevision: null,
              dirty: false,
              pendingSave: null,
              pendingSaveSnapshot: null,
              pendingRestore: null,
              pendingDelete: null,
            }
      ),
    selectVersion: (selectedVersionId) => set({ selectedVersionId }),
    updateDraft: (draft) => set({ draft, dirty: true }),
    hydrateDraft: (result) =>
      set({
        selectedArtifactId: result.artifact.id,
        selectedVersionId: null,
        pendingCreate: null,
        pendingSave: null,
        pendingSaveSnapshot: null,
        pendingRestore: null,
        pendingDelete: null,
        draft: {
          kind: result.artifact.kind,
          title: result.version.title,
          language: result.version.language,
          content: result.version.content,
        },
        baseRevision: result.artifact.revision,
        dirty: false,
      }),
    acknowledgeSave: (result, saved) => {
      const current = get().draft
      const changedWhileSaving =
        !current ||
        current.title !== saved.title ||
        current.language !== saved.language ||
        current.content !== saved.content
      set({
        draft: current ? { ...current, kind: saved.kind } : saved,
        baseRevision: result.artifact.revision,
        dirty: changedWhileSaving,
        selectedVersionId: null,
      })
    },
    setPendingCreate: (pendingCreate) => set({ pendingCreate }),
    setPendingSave: (pendingSave, pendingSaveSnapshot = get().draft) =>
      set({ pendingSave, pendingSaveSnapshot }),
    setPendingRestore: (pendingRestore) => set({ pendingRestore }),
    setPendingDelete: (pendingDelete) => set({ pendingDelete }),
    requestDiscard: (action) => {
      set({ navigationAfterDiscard: action, showDiscardConfirmation: true })
    },
    discardAndContinue: () => {
      const action = get().navigationAfterDiscard
      set({
        navigationAfterDiscard: null,
        showDiscardConfirmation: false,
        dirty: false,
      })
      action?.()
    },
    cancelDiscard: () =>
      set({ navigationAfterDiscard: null, showDiscardConfirmation: false }),
    resetForSession: (nextScope) =>
      set({
        sessionScope: nextScope,
        isOpen: false,
        selectedArtifactId: null,
        selectedVersionId: null,
        draft: null,
        baseRevision: null,
        dirty: false,
        pendingCreate: null,
        pendingSave: null,
        pendingSaveSnapshot: null,
        pendingRestore: null,
        pendingDelete: null,
        navigationAfterDiscard: null,
        showDiscardConfirmation: false,
      }),
  }))
}

async function hashSource(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'Secure browser cryptography is required to create an artifact.'
    )
  }
  const bytes = new TextEncoder().encode(content)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export function usePlaygroundArtifacts(
  ownerId: number | null,
  canonicalSessionId: string | null
) {
  const queryClient = useQueryClient()
  const scope = `${ownerId ?? 'anonymous'}:${canonicalSessionId ?? 'local'}`
  const [store] = useState(() => makeArtifactEditorStore(scope))
  const [sourceError, setSourceError] = useState<Error | null>(null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const requestControllers = useRef(new Set<AbortController>())
  const state = useStore(store)
  const currentOwner = useAuthStore((auth) => auth.auth.user?.id ?? null)
  const enabled =
    ownerId !== null && ownerId === currentOwner && canonicalSessionId !== null
  const requireSessionId = (): string => {
    if (canonicalSessionId === null) {
      throw new Error('Playground session is not available')
    }
    return canonicalSessionId
  }

  const isCurrentRequest = useCallback(
    (controller: AbortController) =>
      !controller.signal.aborted &&
      scopeRef.current === scope &&
      ownerId === useAuthStore.getState().auth.user?.id,
    [ownerId, scope]
  )
  const isCurrentScope = useCallback(
    () =>
      scopeRef.current === scope &&
      ownerId === useAuthStore.getState().auth.user?.id,
    [ownerId, scope]
  )
  const withScopedRequest = useCallback(
    async <T>(request: (signal: AbortSignal) => Promise<T>) => {
      const controller = new AbortController()
      requestControllers.current.add(controller)
      try {
        const result = await request(controller.signal)
        if (!isCurrentRequest(controller)) {
          throw new DOMException('Playground owner changed', 'AbortError')
        }
        return result
      } finally {
        requestControllers.current.delete(controller)
      }
    },
    [isCurrentRequest]
  )

  useEffect(() => {
    const requests = requestControllers.current
    for (const request of requests) request.abort()
    requests.clear()
    setSourceError(null)
    if (state.sessionScope !== scope) store.getState().resetForSession(scope)
    return () => {
      for (const request of requests) request.abort()
      requests.clear()
    }
  }, [scope, state.sessionScope, store])

  useEffect(() => {
    if (!state.dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [state.dirty])

  const listQuery = useQuery({
    queryKey: playgroundQueryKeys.artifactList(ownerId, canonicalSessionId),
    queryFn: ({ signal }) =>
      listPlaygroundArtifacts(requireSessionId(), 1, signal),
    enabled,
    retry: false,
    meta: { errorToast: false },
  })
  const detailQuery = useQuery({
    queryKey: playgroundQueryKeys.artifactDetail(
      ownerId,
      canonicalSessionId,
      state.selectedArtifactId
    ),
    queryFn: ({ signal }) => {
      const artifactId = state.selectedArtifactId
      if (!artifactId) {
        throw new Error('Playground artifact is not selected')
      }
      return getPlaygroundArtifact(
        requireSessionId(),
        artifactId,
        undefined,
        signal
      )
    },
    enabled:
      enabled &&
      state.selectedArtifactId !== null &&
      state.selectedVersionId === null,
    retry: false,
    meta: { errorToast: false },
  })
  const versionsQuery = useQuery({
    queryKey: playgroundQueryKeys.artifactVersions(
      ownerId,
      canonicalSessionId,
      state.selectedArtifactId
    ),
    queryFn: async ({ signal }) => {
      const artifactId = state.selectedArtifactId
      if (!artifactId) {
        throw new Error('Playground artifact is not selected')
      }
      const sessionId = requireSessionId()
      const items: PlaygroundArtifactVersionMetadata[] = []
      let total = Number.POSITIVE_INFINITY
      for (let page = 1; items.length < total; page += 1) {
        const result = await listPlaygroundArtifactVersions(
          sessionId,
          artifactId,
          page,
          signal
        )
        items.push(...result.items)
        total = result.total
        if (result.items.length === 0) break
      }
      return items
    },
    enabled: enabled && state.selectedArtifactId !== null,
    retry: false,
    meta: { errorToast: false },
  })
  const historicalQuery = useQuery({
    queryKey: playgroundQueryKeys.artifactVersion(
      ownerId,
      canonicalSessionId,
      state.selectedArtifactId,
      state.selectedVersionId
    ),
    queryFn: ({ signal }) => {
      const artifactId = state.selectedArtifactId
      const versionId = state.selectedVersionId
      if (!artifactId || !versionId) {
        throw new Error('Playground artifact version is not selected')
      }
      return getPlaygroundArtifact(
        requireSessionId(),
        artifactId,
        versionId,
        signal
      )
    },
    enabled:
      enabled &&
      state.selectedArtifactId !== null &&
      state.selectedVersionId !== null,
    retry: false,
    meta: { errorToast: false },
  })

  const listMutation = useMutation({
    mutationFn: (request: CreatePlaygroundArtifactRequest) =>
      withScopedRequest((signal) =>
        createPlaygroundArtifact(requireSessionId(), request, signal)
      ),
    retry: false,
    meta: { errorToast: false },
    onSuccess: (result) => {
      if (!isCurrentScope()) return
      store.getState().hydrateDraft(result)
      store.getState().setOpen(true)
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactList(ownerId, canonicalSessionId),
      })
      queryClient.setQueryData(
        playgroundQueryKeys.artifactDetail(
          ownerId,
          canonicalSessionId,
          result.artifact.id
        ),
        result
      )
    },
  })
  const saveMutation = useMutation({
    mutationFn: (input: {
      artifactId: string
      request: SavePlaygroundArtifactRequest
      saved: ArtifactDraft
    }) =>
      withScopedRequest((signal) =>
        savePlaygroundArtifactVersion(
          requireSessionId(),
          input.artifactId,
          input.request,
          signal
        )
      ),
    retry: false,
    meta: { errorToast: false },
    onSuccess: (result, input) => {
      if (!isCurrentScope()) return
      store.getState().acknowledgeSave(result, input.saved)
      queryClient.setQueryData(
        playgroundQueryKeys.artifactDetail(
          ownerId,
          canonicalSessionId,
          result.artifact.id
        ),
        result
      )
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactVersions(
          ownerId,
          canonicalSessionId,
          result.artifact.id
        ),
      })
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactList(ownerId, canonicalSessionId),
      })
    },
  })
  const restoreMutation = useMutation({
    mutationFn: (input: {
      artifactId: string
      requestId: string
      revision: number
      versionId: string
    }) =>
      withScopedRequest((signal) =>
        restorePlaygroundArtifactVersion(
          requireSessionId(),
          input.artifactId,
          {
            request_id: input.requestId,
            expected_revision: input.revision,
            version_id: input.versionId,
          },
          signal
        )
      ),
    retry: false,
    meta: { errorToast: false },
    onSuccess: (result) => {
      if (!isCurrentScope()) return
      store.getState().hydrateDraft(result)
      queryClient.setQueryData(
        playgroundQueryKeys.artifactDetail(
          ownerId,
          canonicalSessionId,
          result.artifact.id
        ),
        result
      )
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactVersions(
          ownerId,
          canonicalSessionId,
          result.artifact.id
        ),
      })
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactList(ownerId, canonicalSessionId),
      })
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (input: { artifactId: string; revision: number }) =>
      withScopedRequest((signal) =>
        deletePlaygroundArtifact(
          requireSessionId(),
          input.artifactId,
          input.revision,
          signal
        )
      ),
    retry: false,
    meta: { errorToast: false },
    onSuccess: (_, input) => {
      if (!isCurrentScope()) return
      store.getState().selectArtifact(null)
      store.getState().setPendingDelete(null)
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactList(ownerId, canonicalSessionId),
      })
      queryClient.removeQueries({
        queryKey: playgroundQueryKeys.artifactDetail(
          ownerId,
          canonicalSessionId,
          input.artifactId
        ),
      })
      queryClient.removeQueries({
        queryKey: playgroundQueryKeys.artifactVersions(
          ownerId,
          canonicalSessionId,
          input.artifactId
        ),
      })
    },
  })

  const createFromSource = useCallback(
    async (
      selection: {
        kind: ArtifactDraft['kind']
        title: string
        language: string
        content: string
        codeBlockIndex?: number
      },
      source: CapturedArtifactSource
    ) => {
      if (
        !enabled ||
        !isCurrentScope() ||
        ownerId !== source.ownerId ||
        canonicalSessionId !== source.sessionId ||
        source.messageRevision < 1
      ) {
        return false
      }
      setSourceError(null)
      try {
        const request: CreatePlaygroundArtifactRequest = {
          request_id: nanoid(),
          kind: selection.kind,
          title: selection.title,
          language: selection.language,
          content: selection.content,
          source: {
            message_key: source.messageKey,
            version_id: source.versionId,
            message_revision: source.messageRevision,
            content_hash: await hashSource(source.rawContent),
            code_block_index: selection.codeBlockIndex,
          },
        }
        if (useAuthStore.getState().auth.user?.id !== source.ownerId) {
          return false
        }
        store.getState().setPendingCreate(request)
        await listMutation.mutateAsync(request)
        store.getState().setPendingCreate(null)
        return true
      } catch (error) {
        setSourceError(
          error instanceof Error ? error : new Error(String(error))
        )
        return false
      }
    },
    [canonicalSessionId, enabled, isCurrentScope, listMutation, ownerId, store]
  )

  const retryCreate = useCallback(async () => {
    const request = store.getState().pendingCreate
    if (!request) return false
    try {
      await listMutation.mutateAsync(request)
      store.getState().setPendingCreate(null)
      return true
    } catch {
      return false
    }
  }, [listMutation, store])

  const saveDraft = useCallback(async () => {
    const current = store.getState()
    if (
      !enabled ||
      !current.draft ||
      !current.selectedArtifactId ||
      current.baseRevision === null
    ) {
      return false
    }
    const saved = current.pendingSaveSnapshot
      ? { ...current.pendingSaveSnapshot }
      : { ...current.draft }
    const request = current.pendingSave ?? {
      request_id: nanoid(),
      expected_revision: current.baseRevision,
      title: saved.title,
      language: saved.language,
      content: saved.content,
    }
    store.getState().setPendingSave(request, saved)
    try {
      await saveMutation.mutateAsync({
        artifactId: current.selectedArtifactId,
        request,
        saved,
      })
      store.getState().setPendingSave(null, null)
      return true
    } catch {
      return false
    }
  }, [enabled, saveMutation, store])

  const restoreVersion = useCallback(async () => {
    const current = store.getState()
    if (
      !enabled ||
      !current.selectedArtifactId ||
      current.baseRevision === null ||
      !current.selectedVersionId
    ) {
      return false
    }
    const request = current.pendingRestore ?? {
      requestId: nanoid(),
      revision: current.baseRevision,
      versionId: current.selectedVersionId,
    }
    store.getState().setPendingRestore(request)
    try {
      await restoreMutation.mutateAsync({
        artifactId: current.selectedArtifactId,
        ...request,
      })
      store.getState().setPendingRestore(null)
      return true
    } catch {
      return false
    }
  }, [enabled, restoreMutation, store])

  const reloadHead = useCallback(async () => {
    const current = store.getState()
    const artifactId = current.selectedArtifactId
    if (
      !enabled ||
      !artifactId ||
      ownerId === null ||
      canonicalSessionId === null
    ) {
      return false
    }
    const sessionId = canonicalSessionId
    try {
      const result = await withScopedRequest((signal) =>
        getPlaygroundArtifact(sessionId, artifactId, undefined, signal)
      )
      if (!isCurrentScope()) return false
      queryClient.setQueryData(
        playgroundQueryKeys.artifactDetail(
          ownerId,
          canonicalSessionId,
          result.artifact.id
        ),
        result
      )
      store.getState().hydrateDraft(result)
      // The reload resolves the conflict; stale write errors must not keep the
      // conflict banner and retry action on screen.
      saveMutation.reset()
      restoreMutation.reset()
      deleteMutation.reset()
      return true
    } catch {
      return false
    }
  }, [
    canonicalSessionId,
    deleteMutation,
    enabled,
    isCurrentScope,
    ownerId,
    queryClient,
    restoreMutation,
    saveMutation,
    store,
    withScopedRequest,
  ])

  const deleteArtifact = useCallback(async () => {
    const current = store.getState()
    if (
      !enabled ||
      !current.selectedArtifactId ||
      current.baseRevision === null
    ) {
      return false
    }
    const request = current.pendingDelete ?? {
      artifactId: current.selectedArtifactId,
      revision: current.baseRevision,
    }
    store.getState().setPendingDelete(request)
    try {
      await deleteMutation.mutateAsync(request)
      store.getState().setPendingDelete(null)
      return true
    } catch {
      return false
    }
  }, [deleteMutation, enabled, store])

  const pendingError =
    listMutation.error ??
    saveMutation.error ??
    restoreMutation.error ??
    deleteMutation.error
  const queryError =
    listQuery.error ??
    detailQuery.error ??
    versionsQuery.error ??
    historicalQuery.error
  const error = pendingError ?? queryError ?? sourceError
  const conflict = getServerErrorStatus(error) === 409

  useEffect(() => {
    if (!detailQuery.data || state.dirty || state.selectedVersionId !== null) {
      return
    }
    const current = store.getState()
    if (
      current.baseRevision === detailQuery.data.artifact.revision &&
      current.draft
    ) {
      return
    }
    store.getState().hydrateDraft(detailQuery.data)
  }, [detailQuery.data, state.dirty, state.selectedVersionId, store])

  const retry = useCallback(() => {
    if (state.pendingSave) {
      void saveDraft()
      return
    }
    if (state.pendingRestore) {
      void restoreVersion()
      return
    }
    if (state.pendingDelete) {
      void deleteArtifact()
      return
    }
    if (store.getState().pendingCreate) {
      void retryCreate()
      return
    }
    void queryClient.invalidateQueries({
      queryKey: playgroundQueryKeys.artifactList(ownerId, canonicalSessionId),
    })
    if (state.selectedArtifactId) {
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.artifactDetail(
          ownerId,
          canonicalSessionId,
          state.selectedArtifactId
        ),
      })
    }
  }, [
    canonicalSessionId,
    ownerId,
    queryClient,
    retryCreate,
    restoreVersion,
    deleteArtifact,
    saveDraft,
    state.pendingSave,
    state.pendingRestore,
    state.pendingDelete,
    state.selectedArtifactId,
    store,
  ])

  return {
    store,
    state,
    artifacts: listQuery.data?.items ?? [],
    versions: versionsQuery.data ?? [],
    viewedVersion: historicalQuery.data ?? null,
    detail: detailQuery.data ?? null,
    isLoading: listQuery.isLoading || detailQuery.isLoading,
    isSaving:
      listMutation.isPending ||
      saveMutation.isPending ||
      restoreMutation.isPending ||
      deleteMutation.isPending,
    error,
    conflict,
    retry,
    sourceError,
    createFromSource,
    retryCreate,
    saveDraft,
    restoreVersion,
    deleteArtifact,
    reloadHead,
  }
}
