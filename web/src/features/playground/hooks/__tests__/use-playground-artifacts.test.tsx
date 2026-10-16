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
import { webcrypto } from 'node:crypto'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { PlaygroundArtifactResult } from '../../artifact-api'
import { usePlaygroundArtifacts } from '../use-playground-artifacts'

const SESSION = 'pgs_session'
const ARTIFACT_PATH = `/api/playground/sessions/${SESSION}/artifacts`

function artifactResult(
  revision: number,
  content: string
): PlaygroundArtifactResult {
  return {
    artifact: {
      id: 'pga_1',
      session_id: SESSION,
      kind: 'markdown',
      revision,
      current_version_id: `pgv_${revision}`,
      title: 'Document',
      language: 'markdown',
      created_at: 1,
      updated_at: 1,
    },
    version: {
      id: `pgv_${revision}`,
      artifact_id: 'pga_1',
      number: revision,
      title: 'Document',
      language: 'markdown',
      content,
      byte_size: content.length,
      created_at: 1,
    },
  }
}

function mockArtifactServer(result: PlaygroundArtifactResult) {
  return vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === ARTIFACT_PATH) {
      return {
        data: {
          success: true,
          data: {
            items: [result.artifact],
            total: 1,
            page: 1,
            page_size: 50,
          },
        },
      }
    }
    if (url === `${ARTIFACT_PATH}/pga_1/versions`) {
      return {
        data: {
          success: true,
          data: {
            items: [
              {
                id: 'pgv_1',
                artifact_id: 'pga_1',
                number: 1,
                title: 'Document',
                language: 'markdown',
                byte_size: 5,
                created_at: 1,
              },
            ],
            total: 1,
            page: 1,
            page_size: 50,
          },
        },
      }
    }
    return { data: { success: true, data: result } }
  })
}

function mockWriteFailure(status: number) {
  return Object.assign(new Error('Playground write failed'), {
    response: { status },
  })
}

const clients: QueryClient[] = []

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  function Wrapper(props: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    )
  }
  return renderHook(() => usePlaygroundArtifacts(7, SESSION), {
    wrapper: Wrapper,
  })
}

async function openDraft(
  hook: ReturnType<typeof mount>,
  result: PlaygroundArtifactResult
) {
  await waitFor(() =>
    expect(hook.result.current.artifacts.length).toBeGreaterThan(0)
  )
  act(() => hook.result.current.store.getState().selectArtifact('pga_1'))
  await waitFor(() =>
    expect(hook.result.current.state.draft?.content).toBe(
      result.version.content
    )
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
  useAuthStore.getState().auth.setUser({ id: 7, username: 'user', role: 1 })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('a failed save retries with the original request id so the server can deduplicate', async () => {
  const initial = artifactResult(1, 'Server content')
  mockArtifactServer(initial)
  const post = vi
    .spyOn(api, 'post')
    .mockRejectedValueOnce(mockWriteFailure(500))
    .mockResolvedValueOnce({
      data: { success: true, data: artifactResult(2, 'Edited locally') },
    })
  const hook = mount()
  await openDraft(hook, initial)
  act(() =>
    hook.result.current.store.getState().updateDraft({
      kind: 'markdown',
      title: 'Document',
      language: 'markdown',
      content: 'Edited locally',
    })
  )

  await act(async () => {
    expect(await hook.result.current.saveDraft()).toBe(false)
  })
  await waitFor(() => expect(hook.result.current.error).toBeTruthy())
  expect(hook.result.current.state.dirty).toBe(true)

  await act(async () => {
    expect(await hook.result.current.retry()).toBeUndefined()
  })
  await waitFor(() => expect(hook.result.current.state.dirty).toBe(false))
  expect(post).toHaveBeenCalledTimes(2)
  const first = post.mock.calls[0][1] as { request_id: string }
  const second = post.mock.calls[1][1] as { request_id: string }
  expect(second.request_id).toBe(first.request_id)
  expect(second).toMatchObject({
    expected_revision: 1,
    content: 'Edited locally',
  })
  expect(hook.result.current.state.baseRevision).toBe(2)
})

test('a save conflict keeps the local draft and clears after reloading the server head', async () => {
  const initial = artifactResult(1, 'Server content')
  const get = mockArtifactServer(initial)
  vi.spyOn(api, 'post').mockRejectedValue(mockWriteFailure(409))
  const hook = mount()
  await openDraft(hook, initial)
  act(() =>
    hook.result.current.store.getState().updateDraft({
      kind: 'markdown',
      title: 'Document',
      language: 'markdown',
      content: 'Edited locally',
    })
  )

  await act(async () => {
    expect(await hook.result.current.saveDraft()).toBe(false)
  })
  await waitFor(() => expect(hook.result.current.conflict).toBe(true))
  expect(hook.result.current.state.draft?.content).toBe('Edited locally')
  expect(hook.result.current.state.dirty).toBe(true)

  const rewritten = artifactResult(3, 'Server rewritten')
  get.mockImplementation(async (url) => {
    if (url === ARTIFACT_PATH) {
      return {
        data: {
          success: true,
          data: {
            items: [rewritten.artifact],
            total: 1,
            page: 1,
            page_size: 50,
          },
        },
      }
    }
    if (url === `${ARTIFACT_PATH}/pga_1/versions`) {
      return {
        data: {
          success: true,
          data: { items: [], total: 0, page: 1, page_size: 50 },
        },
      }
    }
    return { data: { success: true, data: rewritten } }
  })
  await act(async () => {
    expect(await hook.result.current.reloadHead()).toBe(true)
  })
  await waitFor(() => expect(hook.result.current.conflict).toBe(false))
  expect(hook.result.current.error).toBeFalsy()
  expect(hook.result.current.state.draft?.content).toBe('Server rewritten')
  expect(hook.result.current.state.dirty).toBe(false)
  expect(hook.result.current.state.baseRevision).toBe(3)
})

test('a failed artifact creation retries the same request id', async () => {
  mockArtifactServer(artifactResult(1, 'Server content'))
  const post = vi
    .spyOn(api, 'post')
    .mockRejectedValueOnce(mockWriteFailure(500))
    .mockResolvedValueOnce({
      data: { success: true, data: artifactResult(1, 'Created content') },
    })
  const hook = mount()
  const source = {
    ownerId: 7,
    sessionId: SESSION,
    messageKey: 'assistant',
    versionId: 'v1',
    messageRevision: 1,
    rawContent: 'Raw assistant text',
    visibleContent: 'Created content',
  }
  await act(async () => {
    expect(
      await hook.result.current.createFromSource(
        {
          kind: 'markdown',
          title: 'Document',
          language: 'markdown',
          content: 'Created content',
        },
        source
      )
    ).toBe(false)
  })
  expect(hook.result.current.sourceError).toBeTruthy()

  await act(async () => {
    expect(await hook.result.current.retry()).toBeUndefined()
  })
  await waitFor(() =>
    expect(hook.result.current.state.draft?.content).toBe('Created content')
  )
  expect(post).toHaveBeenCalledTimes(2)
  const first = post.mock.calls[0][1] as { request_id: string }
  const second = post.mock.calls[1][1] as { request_id: string }
  expect(second.request_id).toBe(first.request_id)
})

test('an unsaved draft guards page unload and a clean draft does not', async () => {
  const result = artifactResult(1, 'Server content')
  mockArtifactServer(result)
  const hook = mount()
  await openDraft(hook, result)

  const clean = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(clean)
  expect(clean.defaultPrevented).toBe(false)

  act(() =>
    hook.result.current.store.getState().updateDraft({
      kind: 'markdown',
      title: 'Document',
      language: 'markdown',
      content: 'Edited locally',
    })
  )
  const dirty = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(dirty)
  expect(dirty.defaultPrevented).toBe(true)

  act(() => hook.result.current.store.getState().hydrateDraft(result))
  const reverted = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(reverted)
  expect(reverted.defaultPrevented).toBe(false)
})
