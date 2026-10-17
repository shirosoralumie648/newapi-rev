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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { CanceledError } from 'axios'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import { playgroundQueryKeys } from '../../lib/query-keys'
import { saveSessionsState } from '../../session-storage'
import type { Message, PlaygroundSession } from '../../types'
import { usePlaygroundServer } from '../use-playground-server'
import { usePlaygroundState } from '../use-playground-state'

const clientList: QueryClient[] = []
const message: Message = {
  key: 'm',
  from: 'user',
  versions: [{ id: 'v', content: 'Server history' }],
}
const remote = {
  id: 'pgs_server',
  title: 'Server chat',
  config: DEFAULT_CONFIG,
  parameter_enabled: DEFAULT_PARAMETER_ENABLED,
  created_at: 1,
  updated_at: 2,
  revision: 0,
  message_revision: 0,
}
const localDraft: PlaygroundSession = {
  id: 'local-one',
  title: 'Local chat',
  createdAt: 10,
  updatedAt: 20,
  config: DEFAULT_CONFIG,
  parameterEnabled: DEFAULT_PARAMETER_ENABLED,
  systemPrompt: '',
  messages: [{ ...message, versions: [{ id: 'v', content: 'Local history' }] }],
}

function mount(generating = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clientList.push(client)
  function Wrapper(props: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    )
  }
  const hook = renderHook(
    ({ generating }) => {
      const local = usePlaygroundState()
      const sync = usePlaygroundServer(local, generating)
      return { local, sync }
    },
    { wrapper: Wrapper, initialProps: { generating } }
  )
  return { ...hook, client }
}

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'user', role: 1 })
})
afterEach(() => {
  cleanup()
  for (const client of clientList.splice(0)) client.clear()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  vi.restoreAllMocks()
})

function mockServer() {
  return vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages')
        ? { revision: 0, messages: [{ client_key: 'm', payload: message }] }
        : { items: [remote], total: 1 },
    },
  }))
}

test('existing server history replaces clean browser history while retaining a migration backup', async () => {
  saveSessionsState({ activeSessionId: localDraft.id, sessions: [localDraft] })
  mockServer()
  const post = vi.spyOn(api, 'post')
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe('pgs_server')
  )
  expect(hook.result.current.local.messages[0].versions[0].content).toBe(
    'Server history'
  )
  expect(localStorage.getItem('playground_local_backup:7')).toContain(
    'Local history'
  )
  expect(post).not.toHaveBeenCalled()
  expect(hook.client.getQueryData(playgroundQueryKeys.list(7))).toBeDefined()
  expect(hook.client.getQueryData(playgroundQueryKeys.list(8))).toBeUndefined()
})

test('an empty server migrates the browser session and messages in one create request', async () => {
  saveSessionsState({ activeSessionId: localDraft.id, sessions: [localDraft] })
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages')
        ? {
            revision: 0,
            messages: localDraft.messages.map((payload) => ({
              client_key: payload.key,
              payload,
            })),
          }
        : { items: [], total: 0 },
    },
  }))
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: { ...remote, client_id: localDraft.id, title: localDraft.title },
    },
  })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.sessions[0].server?.id).toBe(remote.id)
  )
  await waitFor(() =>
    expect(hook.result.current.local.sessions[0].syncPending).toBe(false)
  )
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1]).toMatchObject({
    client_id: localDraft.id,
    messages: [{ client_key: 'm', payload: localDraft.messages[0] }],
  })
})

test('server failure leaves the local draft available and retry hydrates without losing it silently', async () => {
  saveSessionsState({ activeSessionId: localDraft.id, sessions: [localDraft] })
  const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('Offline'))
  const hook = mount()
  await waitFor(() => expect(hook.result.current.sync.error).toBeTruthy())
  expect(hook.result.current.local.messages).toEqual(localDraft.messages)
  expect(hook.result.current.sync.isLoading).toBe(false)
  act(() => hook.result.current.local.updateConfig('model', 'offline-model'))
  get.mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages')
        ? { revision: 0, messages: [{ client_key: 'm', payload: message }] }
        : { items: [remote], total: 1 },
    },
  }))
  const post = vi
    .spyOn(api, 'post')
    .mockRejectedValue(new Error('Save offline'))
  act(() => hook.result.current.sync.retry())
  await waitFor(() => expect(hook.result.current.sync.isLoading).toBe(false))
  await waitFor(() =>
    expect(
      hook.result.current.local.sessions.some(
        (session) => session.config.model === 'offline-model'
      )
    ).toBe(true)
  )
  expect(post.mock.calls.length).toBeLessThanOrEqual(1)
})

test('generation coalesces edits and saves only after the response settles', async () => {
  mockServer()
  const patch = vi.spyOn(api, 'patch').mockImplementation(async (url) => {
    if (String(url).endsWith('/messages')) {
      return {
        data: { success: true, data: { revision: 1, upserted: ['m'] } },
      }
    }
    return { data: { success: true, data: { ...remote, revision: 1 } } }
  })
  const hook = mount(true)
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() =>
    hook.result.current.local.updateMessages([
      { ...message, versions: [{ id: 'v', content: 'Final answer' }] },
    ])
  )
  expect(patch).not.toHaveBeenCalled()
  hook.rerender({ generating: false })
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(hook.result.current.local.sessions[0].syncPending).toBe(false)
  )
  const messageCall = patch.mock.calls.find(([url]) =>
    String(url).endsWith('/messages')
  )
  expect(messageCall?.[1]).toMatchObject({
    revision: 0,
    upserts: [
      {
        client_key: 'm',
        payload: { versions: [{ id: 'v', content: 'Final answer' }] },
      },
    ],
    deletes: [],
  })
})

test('edits made while a save is pending remain dirty for the next serialized write', async () => {
  mockServer()
  let finish!: (value: unknown) => void
  vi.spyOn(api, 'patch')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockRejectedValue(new Error('Next write held'))
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() => hook.result.current.local.renameSession(remote.id, 'First edit'))
  await waitFor(() => expect(finish).toBeDefined())
  act(() => hook.result.current.local.renameSession(remote.id, 'Second edit'))
  await act(async () =>
    finish({
      data: {
        success: true,
        data: { ...remote, title: 'First edit', revision: 1 },
      },
    })
  )
  expect(hook.result.current.local.sessions[0].title).toBe('Second edit')
  expect(hook.result.current.local.sessions[0].syncPending).toBe(true)
})

test('a canceled conversation load is restarted without a sync failure', async () => {
  const get = mockServer()
  get.mockRejectedValueOnce(new CanceledError('canceled'))
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  expect(hook.result.current.sync.error).toBeFalsy()
  const listCalls = get.mock.calls.filter(([url]) =>
    String(url).endsWith('/playground/sessions')
  )
  expect(listCalls.length).toBe(2)
})

test('a canceled write is retried without surfacing a sync failure', async () => {
  mockServer()
  const patch = vi
    .spyOn(api, 'patch')
    .mockRejectedValueOnce(new CanceledError('canceled'))
    .mockResolvedValueOnce({
      data: {
        success: true,
        data: { ...remote, title: 'Edited', revision: 1 },
      },
    })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() => hook.result.current.local.renameSession(remote.id, 'Edited'))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  })
  await waitFor(
    () => expect(hook.result.current.local.sessions[0].syncPending).toBe(false),
    { timeout: 3000 }
  )
  expect(hook.result.current.sync.error).toBeFalsy()
  expect(patch).toHaveBeenCalledTimes(2)
})

test('a version conflict pauses saving and preserves unsynced local content', async () => {
  mockServer()
  vi.spyOn(api, 'patch').mockRejectedValue({
    response: { status: 409, data: { message: 'Version conflict' } },
  })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() => hook.result.current.local.renameSession(remote.id, 'Unsaved title'))
  await waitFor(() => expect(hook.result.current.sync.error).toBeTruthy())
  expect(hook.result.current.local.sessions[0]).toMatchObject({
    title: 'Unsaved title',
    syncPending: true,
    server: { revision: 0 },
  })
})

test('an account change aborts outstanding writes before they can continue under new credentials', async () => {
  mockServer()
  let signal: AbortSignal | undefined
  let finish!: (value: unknown) => void
  const patch = vi
    .spyOn(api, 'patch')
    .mockImplementation((_url, _body, config) => {
      signal = config?.signal as AbortSignal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() => hook.result.current.local.renameSession(remote.id, 'Pending'))
  await waitFor(() => expect(signal).toBeDefined())
  act(() =>
    useAuthStore.getState().auth.setUser({ id: 8, username: 'other', role: 1 })
  )
  expect(signal?.aborted).toBe(true)
  hook.unmount()
  await act(async () =>
    finish({ data: { success: true, data: { ...remote, revision: 1 } } })
  )
  // The aborted write stays the only one: no message delta follows it.
  expect(patch).toHaveBeenCalledTimes(1)
})

test('a failed remote deletion remains queued rather than resurrecting a deleted conversation', async () => {
  mockServer()
  vi.spyOn(api, 'delete').mockRejectedValue(new Error('Offline'))
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() => hook.result.current.sync.deleteSession(remote.id))
  await waitFor(() => expect(hook.result.current.sync.error).toBeTruthy())
  expect(
    hook.result.current.local.sessions.some(
      (session) => session.id === remote.id
    )
  ).toBe(false)
  expect(localStorage.getItem('playground_pending_deletes:7')).toContain(
    remote.id
  )
})

test('conflict recovery creates a new conversation without overwriting the remote version', async () => {
  mockServer()
  const patch = vi.spyOn(api, 'patch').mockRejectedValue({
    response: { status: 409, data: { message: 'Version conflict' } },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: { ...remote, id: 'pgs_copy', title: 'My draft', created: true },
    },
  })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )
  act(() => hook.result.current.local.renameSession(remote.id, 'My draft'))
  await waitFor(() => expect(hook.result.current.sync.conflict).toBe(true))
  act(() => hook.result.current.sync.saveAsNew())
  await waitFor(() =>
    expect(hook.result.current.local.sessions[0].server?.id).toBe('pgs_copy')
  )
  expect(hook.result.current.local.sessions[0].title).toBe('My draft')
  expect(patch).toHaveBeenCalledTimes(1)
  expect(post).toHaveBeenCalledTimes(1)
})

test('pending edits restored from browser storage keep the original server revision', async () => {
  saveSessionsState({
    activeSessionId: localDraft.id,
    sessions: [
      {
        ...localDraft,
        syncPending: true,
        server: { id: remote.id, revision: 0, messageRevision: 0 },
      },
    ],
  })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [{ ...remote, revision: 5 }], total: 1 },
    },
  })
  const hook = mount(true)
  await waitFor(() => expect(hook.result.current.sync.isLoading).toBe(false))
  expect(hook.result.current.local.sessions[0]).toMatchObject({
    title: 'Local chat',
    server: { revision: 0 },
    syncPending: true,
  })
  expect(hook.result.current.local.messages).toEqual(localDraft.messages)
})

test('a lost creation acknowledgement does not replace newer unsynced browser edits on reload', async () => {
  saveSessionsState({
    activeSessionId: localDraft.id,
    sessions: [{ ...localDraft, syncPending: true }],
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages')
        ? { revision: 3, messages: [{ client_key: 'm', payload: message }] }
        : {
            items: [
              {
                ...remote,
                client_id: localDraft.id,
                revision: 2,
                message_revision: 3,
              },
            ],
            total: 1,
          },
    },
  }))
  const hook = mount(true)
  await waitFor(() => expect(hook.result.current.sync.isLoading).toBe(false))
  expect(hook.result.current.local.messages).toEqual(localDraft.messages)
  expect(hook.result.current.local.sessions[0]).toMatchObject({
    syncPending: true,
    server: { id: remote.id, revision: 0, messageRevision: 0 },
  })
})

test('an incremental save sends only the changed messages and the removed keys', async () => {
  const history: Message[] = [
    { key: 'm1', from: 'user', versions: [{ id: 'v1', content: 'First' }] },
    {
      key: 'm2',
      from: 'assistant',
      versions: [{ id: 'v2', content: 'Second' }],
    },
  ]
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: url.endsWith('/messages')
        ? {
            revision: 2,
            messages: history.map((payload) => ({
              client_key: payload.key,
              payload,
            })),
          }
        : { items: [{ ...remote, message_revision: 2 }], total: 1 },
    },
  }))
  const patch = vi.spyOn(api, 'patch').mockImplementation(async (url) => {
    if (String(url).endsWith('/messages')) {
      return {
        data: { success: true, data: { revision: 3, upserted: ['m1', 'm3'] } },
      }
    }
    return { data: { success: true, data: { ...remote, revision: 1 } } }
  })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )

  act(() =>
    hook.result.current.local.updateMessages([
      { ...history[0], versions: [{ id: 'v1', content: 'First edited' }] },
      { key: 'm3', from: 'user', versions: [{ id: 'v3', content: 'Third' }] },
    ])
  )
  await waitFor(() =>
    expect(hook.result.current.local.sessions[0].syncPending).toBe(false)
  )

  const messageCall = patch.mock.calls.find(([url]) =>
    String(url).endsWith('/messages')
  )
  const body = messageCall?.[1] as {
    revision: number
    upserts: { client_key: string }[]
    deletes: string[]
  }
  expect(body.revision).toBe(2)
  expect(body.upserts.map((item) => item.client_key)).toEqual(['m1', 'm3'])
  expect(body.deletes).toEqual(['m2'])
  expect(hook.result.current.local.sessions[0].server?.messageRevision).toBe(3)
})

test('a save without message changes skips the message write and keeps the revision', async () => {
  mockServer()
  const patch = vi.spyOn(api, 'patch').mockImplementation(async (url) => {
    if (String(url).endsWith('/messages')) {
      throw new Error('The stored snapshot already matches')
    }
    return {
      data: {
        success: true,
        data: { ...remote, title: 'Renamed', revision: 1 },
      },
    }
  })
  const hook = mount()
  await waitFor(() =>
    expect(hook.result.current.local.activeSessionId).toBe(remote.id)
  )

  act(() => hook.result.current.local.renameSession(remote.id, 'Renamed'))
  await waitFor(() =>
    expect(hook.result.current.local.sessions[0].syncPending).toBe(false)
  )

  expect(patch).toHaveBeenCalledTimes(1)
  expect(hook.result.current.local.sessions[0].server).toEqual({
    id: remote.id,
    revision: 1,
    messageRevision: 0,
  })
})
