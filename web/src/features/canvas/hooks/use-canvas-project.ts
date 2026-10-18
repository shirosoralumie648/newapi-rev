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
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getServerErrorStatus } from '@/lib/server-error-message'

import {
  createCanvasProject,
  deleteCanvasProject,
  getCanvasProject,
  listCanvasProjects,
  restoreCanvasSnapshot,
  updateCanvasProject,
} from '../api'
import {
  CANVAS_AUTOSAVE_DELAY_MS,
  CANVAS_DEFAULT_TITLE,
  CANVAS_STORAGE_LAST_PROJECT,
} from '../constants'
import {
  applyCanvasReferenceStatus,
  createEmptyCanvasDocument,
} from '../lib/canvas-document'
import type {
  CanvasProjectSummary,
  CanvasServerDocument,
  CanvasServerProject,
} from '../types'

export type CanvasSaveStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'error'
  | 'conflict'

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function readStoredProjectId(key: string | null): string | null {
  if (!key) return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Owns the canvas project list, the active project, autosave with revision
 * compare-and-swap and the unsaved-edit guard. Every project operation stays
 * scoped to the signed-in account through the localStorage key and the
 * server-side owner filter.
 */
export function useCanvasProject(
  userId: number | null,
  preferredProjectId?: string
) {
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([])
  const [project, setProject] = useState<CanvasServerProject | null>(null)
  const [status, setStatus] = useState<CanvasSaveStatus>('idle')
  const [error, setError] = useState<Error | null>(null)
  const [dirty, setDirty] = useState(false)

  const mounted = useRef(true)
  const generation = useRef(0)
  const projectRef = useRef<CanvasServerProject | null>(null)
  const projectsRef = useRef<CanvasProjectSummary[]>([])
  const revisionRef = useRef(0)
  const pendingDocument = useRef<CanvasServerDocument | null>(null)
  const savingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const lastProjectKey = userId
    ? `${CANVAS_STORAGE_LAST_PROJECT}:${userId}`
    : null

  const applyProjects = useCallback((next: CanvasProjectSummary[]) => {
    projectsRef.current = next
    setProjects(next)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  const setActiveProject = useCallback(
    (next: CanvasServerProject | null) => {
      projectRef.current = next
      revisionRef.current = next?.revision ?? 0
      setProject(next)
      if (next && lastProjectKey) {
        try {
          localStorage.setItem(lastProjectKey, next.id)
        } catch {
          /* storage unavailable; selection falls back to the first project */
        }
      }
    },
    [lastProjectKey]
  )

  const loadProject = useCallback(
    async (projectId: string) => {
      const current = ++generation.current
      setStatus('loading')
      setError(null)
      try {
        const loaded = await getCanvasProject(projectId)
        if (!mounted.current || generation.current !== current) return
        pendingDocument.current = null
        setDirty(false)
        setActiveProject(applyCanvasReferenceStatus(loaded))
        setStatus('ready')
      } catch (loadError) {
        if (!mounted.current || generation.current !== current) return
        setError(toError(loadError))
        setStatus('error')
      }
    },
    [setActiveProject]
  )

  const refreshProjects = useCallback(
    async (preferredId?: string | null): Promise<CanvasProjectSummary[]> => {
      const rows = await listCanvasProjects()
      if (!mounted.current) return rows
      applyProjects(rows)
      const wanted = preferredId ?? readStoredProjectId(lastProjectKey)
      const next = rows.find((row) => row.id === wanted) ?? rows[0] ?? null
      if (next) {
        await loadProject(next.id)
      } else {
        setActiveProject(null)
        pendingDocument.current = null
        setDirty(false)
        setStatus('ready')
      }
      return rows
    },
    [applyProjects, lastProjectKey, loadProject, setActiveProject]
  )

  // (re)load whenever the account changes; the account-keyed route remounts
  // on sign-in but the hook also guards in-place account switches.
  useEffect(() => {
    if (!userId) {
      applyProjects([])
      setActiveProject(null)
      pendingDocument.current = null
      setDirty(false)
      setStatus('idle')
      return
    }
    void refreshProjects(preferredProjectId).catch((loadError) => {
      if (!mounted.current) return
      setError(toError(loadError))
      setStatus('error')
    })
  }, [
    userId,
    preferredProjectId,
    refreshProjects,
    setActiveProject,
    applyProjects,
  ])

  const flush = useCallback(async () => {
    const active = projectRef.current
    const document = pendingDocument.current
    if (!active || !document || savingRef.current) return
    savingRef.current = true
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setStatus('saving')
    const sentRevision = revisionRef.current
    try {
      const updated = await updateCanvasProject(active.id, {
        revision: sentRevision,
        document,
      })
      if (!mounted.current) return
      revisionRef.current = updated.revision
      projectRef.current = { ...updated, document }
      setProject((current) =>
        current && current.id === updated.id
          ? { ...updated, document: current.document }
          : current
      )
      if (pendingDocument.current === document) {
        pendingDocument.current = null
        setDirty(false)
      }
      applyProjects(
        projectsRef.current.map((row) =>
          row.id === updated.id
            ? {
                ...row,
                title: updated.title,
                nodeCount: updated.nodeCount,
                edgeCount: updated.edgeCount,
                documentBytes: updated.documentBytes,
                revision: updated.revision,
                updatedAt: updated.updatedAt,
              }
            : row
        )
      )
      setStatus('ready')
      setError(null)
    } catch (saveError) {
      if (!mounted.current) return
      if (getServerErrorStatus(saveError) === 409) {
        setStatus('conflict')
      } else {
        setError(toError(saveError))
        setStatus('error')
      }
    } finally {
      savingRef.current = false
      // Edits made while the request was in flight get their own save.
      if (mounted.current && pendingDocument.current) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          void flush()
        }, CANVAS_AUTOSAVE_DELAY_MS)
      }
    }
  }, [applyProjects])

  const scheduleSave = useCallback(
    (document: CanvasServerDocument) => {
      pendingDocument.current = document
      setDirty(true)
      if (savingRef.current || timerRef.current !== null) return
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void flush()
      }, CANVAS_AUTOSAVE_DELAY_MS)
    },
    [flush]
  )

  const flushNow = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await flush()
  }, [flush])

  const createNewProject = useCallback(
    async (title?: string) => {
      await flush()
      const created = await createCanvasProject({
        clientId: nanoid(),
        title: title ?? CANVAS_DEFAULT_TITLE,
        document: createEmptyCanvasDocument(),
      })
      if (!mounted.current) return created
      pendingDocument.current = null
      setDirty(false)
      setActiveProject(created)
      setStatus('ready')
      setError(null)
      applyProjects([
        created,
        ...projectsRef.current.filter((row) => row.id !== created.id),
      ])
      return created
    },
    [applyProjects, flush, setActiveProject]
  )

  const selectProject = useCallback(
    async (id: string) => {
      if (projectRef.current?.id === id) return
      // Persist the current board before switching so autosave cannot target
      // the freshly opened project.
      await flush()
      await loadProject(id)
    },
    [flush, loadProject]
  )

  const renameProject = useCallback(
    async (id: string, title: string) => {
      // A pending autosave shares the revision counter; settle it first so the
      // rename does not race the save into a conflict.
      if (projectRef.current?.id === id) await flush()
      const active = projectRef.current
      const summary = projectsRef.current.find((row) => row.id === id)
      const revision =
        active?.id === id ? revisionRef.current : summary?.revision
      if (revision === undefined) return
      const updated = await updateCanvasProject(id, { revision, title })
      if (!mounted.current) return
      if (active?.id === id) {
        revisionRef.current = updated.revision
        projectRef.current = {
          ...active,
          title: updated.title,
          revision: updated.revision,
        }
        setProject((current) =>
          current?.id === id
            ? { ...current, title: updated.title, revision: updated.revision }
            : current
        )
      }
      applyProjects(
        projectsRef.current.map((row) =>
          row.id === id
            ? { ...row, title: updated.title, revision: updated.revision }
            : row
        )
      )
    },
    [applyProjects, flush]
  )

  const deleteProject = useCallback(
    async (id: string) => {
      await deleteCanvasProject(id)
      if (!mounted.current) return
      const remaining = projectsRef.current.filter((row) => row.id !== id)
      applyProjects(remaining)
      if (projectRef.current?.id !== id) return
      pendingDocument.current = null
      setDirty(false)
      const next = remaining[0] ?? null
      if (next) {
        await loadProject(next.id)
      } else {
        setActiveProject(null)
        setStatus('ready')
      }
    },
    [applyProjects, loadProject, setActiveProject]
  )

  const discardLocalChanges = useCallback(async () => {
    const active = projectRef.current
    if (!active) return
    pendingDocument.current = null
    setDirty(false)
    setStatus('loading')
    setError(null)
    try {
      const reloaded = await getCanvasProject(active.id)
      if (!mounted.current) return
      setActiveProject(applyCanvasReferenceStatus(reloaded))
      setStatus('ready')
    } catch (loadError) {
      if (!mounted.current) return
      setError(toError(loadError))
      setStatus('error')
    }
  }, [setActiveProject])

  const restoreSnapshot = useCallback(
    async (snapshotId: string): Promise<CanvasServerProject | null> => {
      const active = projectRef.current
      if (!active) return null
      // A pending autosave shares the revision counter; settle it first so the
      // restore does not race the save into a conflict.
      await flush()
      const restored = await restoreCanvasSnapshot(
        active.id,
        snapshotId,
        revisionRef.current
      )
      if (!mounted.current) return restored
      pendingDocument.current = null
      setDirty(false)
      setActiveProject(applyCanvasReferenceStatus(restored))
      setStatus('ready')
      setError(null)
      applyProjects(
        projectsRef.current.map((row) =>
          row.id === restored.id
            ? {
                ...row,
                title: restored.title,
                nodeCount: restored.nodeCount,
                edgeCount: restored.edgeCount,
                documentBytes: restored.documentBytes,
                revision: restored.revision,
                updatedAt: restored.updatedAt,
              }
            : row
        )
      )
      return restored
    },
    [applyProjects, flush, setActiveProject]
  )

  // A pending write means local edits would be lost on navigation.
  useEffect(() => {
    if (!dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
      return ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  return {
    projects,
    project,
    status,
    error,
    dirty,
    conflict: status === 'conflict',
    loadProject,
    selectProject,
    refreshProjects,
    createNewProject,
    renameProject,
    deleteProject,
    scheduleSave,
    flushNow,
    discardLocalChanges,
    restoreSnapshot,
  }
}
