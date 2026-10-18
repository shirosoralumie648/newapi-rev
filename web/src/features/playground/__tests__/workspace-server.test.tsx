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
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../constants'
import { Playground } from '../index'

const originalAnimations = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'getAnimations'
)
const clients: QueryClient[] = []
const remote = {
  id: 'pgs_workspace',
  title: 'Remote conversation',
  config: DEFAULT_CONFIG,
  parameter_enabled: DEFAULT_PARAMETER_ENABLED,
  created_at: 1,
  updated_at: 2,
  revision: 0,
  message_revision: 0,
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Playground />
    </QueryClientProvider>
  )
}
function options(url: string): unknown {
  if (url.includes('/models')) return ['gpt-4o']
  return { default: { desc: 'default', ratio: 1 } }
}
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
  localStorage.clear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'seven', role: 1 })
})
afterEach(() => {
  if (originalAnimations) {
    Object.defineProperty(
      HTMLElement.prototype,
      'getAnimations',
      originalAnimations
    )
  } else Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  vi.restoreAllMocks()
})

test('the workspace disables conversation edits until server hydration and shows the selected server history', async () => {
  let resolveList!: (value: unknown) => void
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/sessions')) {
      return new Promise((resolve) => {
        resolveList = resolve
      })
    }
    if (url.endsWith('/messages')) {
      return {
        data: {
          success: true,
          data: {
            revision: 0,
            messages: [
              {
                client_key: 'm',
                payload: {
                  key: 'm',
                  from: 'user',
                  versions: [
                    { id: 'v', content: 'History from another device' },
                  ],
                },
              },
            ],
          },
        },
      }
    }
    return { data: { success: true, data: options(url) } }
  })
  mount()
  expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled()
  await waitFor(() => expect(resolveList).toBeDefined())
  await act(async () =>
    resolveList({
      data: { success: true, data: { items: [remote], total: 1 } },
    })
  )
  expect(
    await screen.findByRole('button', { name: 'Remote conversation' })
  ).toHaveAttribute('aria-pressed', 'true')
  expect(await screen.findByText('History from another device')).toBeVisible()
  expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled()
})

test('failed hydration displays a retryable error without disabling the local composer', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/sessions')) throw new Error('Offline')
    return { data: { success: true, data: options(url) } }
  })
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Conversation sync failed. Your draft is kept locally.'
  )
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled()
})

test('switching accounts unmounts private history instead of reusing the previous query cache', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    const owner = useAuthStore.getState().auth.user?.id
    if (url.endsWith('/sessions')) {
      return {
        data: {
          success: true,
          data: {
            items: [
              {
                ...remote,
                id: `pgs_${owner}`,
                title: `Account ${owner} history`,
              },
            ],
            total: 1,
          },
        },
      }
    }
    if (url.endsWith('/messages')) {
      return { data: { success: true, data: { revision: 0, messages: [] } } }
    }
    return { data: { success: true, data: options(url) } }
  })
  mount()
  expect(
    await screen.findByRole('button', { name: 'Account 7 history' })
  ).toBeVisible()
  act(() =>
    useAuthStore.getState().auth.setUser({ id: 8, username: 'eight', role: 1 })
  )
  expect(
    screen.queryByRole('button', { name: 'Account 7 history' })
  ).not.toBeInTheDocument()
  expect(
    await screen.findByRole('button', { name: 'Account 8 history' })
  ).toBeVisible()
})

test('restoring a conversation from the trash returns it to the conversation list', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/sessions')) {
      return { data: { success: true, data: { items: [], total: 0 } } }
    }
    if (url === '/api/playground/trash') {
      return {
        data: {
          success: true,
          data: {
            retention_days: 30,
            items: [
              {
                kind: 'session',
                id: 'pgs_restored',
                title: 'Restored conversation',
                deleted_at: 10,
                purge_at: 20,
              },
            ],
          },
        },
      }
    }
    if (url.endsWith('/messages')) {
      return { data: { success: true, data: { revision: 0, messages: [] } } }
    }
    return { data: { success: true, data: options(url) } }
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/api/playground/sessions/pgs_restored/restore') {
      return {
        data: {
          success: true,
          data: {
            ...remote,
            id: 'pgs_restored',
            title: 'Restored conversation',
          },
        },
      }
    }
    // The workspace persists its own empty draft through the same endpoint.
    return {
      data: { success: true, data: { ...remote, created: true } },
    }
  })

  mount()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled()
  )
  await user.click(screen.getByRole('button', { name: 'Trash' }))
  await user.click(
    await screen.findByRole('button', {
      name: 'Restore Restored conversation',
    })
  )

  expect(
    await screen.findByRole('button', { name: 'Restored conversation' })
  ).toBeVisible()
  expect(post).toHaveBeenCalledWith(
    '/api/playground/sessions/pgs_restored/restore',
    undefined,
    expect.objectContaining({ signal: expect.anything() })
  )
})

test('on mobile the conversation drawer opens by keyboard and exposes the active server session', async () => {
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  })
  try {
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/sessions')) {
        return { data: { success: true, data: { items: [remote], total: 1 } } }
      }
      if (url.endsWith('/messages')) {
        return { data: { success: true, data: { revision: 0, messages: [] } } }
      }
      return { data: { success: true, data: options(url) } }
    })
    const user = userEvent.setup()
    mount()
    const trigger = await screen.findByRole('button', {
      name: 'Open conversations',
    })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByRole('dialog', { name: 'Conversations' })
    ).toBeVisible()
    expect(
      await screen.findByRole('button', { name: 'Remote conversation' })
    ).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  } finally {
    if (width) Object.defineProperty(window, 'innerWidth', width)
  }
})
