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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { PlaygroundArtifactResult } from '../../../artifact-api'
import { usePlaygroundArtifacts } from '../../../hooks/use-playground-artifacts'
import { PlaygroundArtifactPanel } from '../playground-artifact-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const SESSION = 'pgs_session'
const ARTIFACT_PATH = `/api/playground/sessions/${SESSION}/artifacts`
const onClose = vi.fn()

function makeResult(
  id: string,
  title: string,
  content: string
): PlaygroundArtifactResult {
  return {
    artifact: {
      id,
      session_id: SESSION,
      kind: 'markdown',
      revision: 1,
      current_version_id: `${id}_v1`,
      title,
      language: 'markdown',
      created_at: 1,
      updated_at: 1,
    },
    version: {
      id: `${id}_v1`,
      artifact_id: id,
      number: 1,
      title,
      language: 'markdown',
      content,
      byte_size: content.length,
      created_at: 1,
    },
  }
}

const first = makeResult('pga_first', 'Document One', 'First content')
const second = makeResult('pga_second', 'Document Two', 'Second content')

function Harness() {
  const controller = usePlaygroundArtifacts(7, SESSION)
  return <PlaygroundArtifactPanel controller={controller} onClose={onClose} />
}

beforeEach(() => {
  localStorage.clear()
  onClose.mockClear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'user', role: 1 })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === ARTIFACT_PATH) {
      return {
        data: {
          success: true,
          data: {
            items: [first.artifact, second.artifact],
            total: 2,
            page: 1,
            page_size: 50,
          },
        },
      }
    }
    const parts = url.split('/')
    const id = url.endsWith('/versions') ? parts.at(-2) : parts.at(-1)
    if (!id) {
      throw new Error(`Unexpected URL in test: ${url}`)
    }
    if (url.endsWith('/versions')) {
      return {
        data: {
          success: true,
          data: {
            items: [
              {
                id: `${id}_v1`,
                artifact_id: id,
                number: 1,
                title: id === 'pga_first' ? 'Document One' : 'Document Two',
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
    const result = id === 'pga_first' ? first : second
    return { data: { success: true, data: result } }
  })
})

afterEach(() => {
  cleanup()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  vi.restoreAllMocks()
})

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
  return client
}

test('switching artifacts with unsaved changes asks before discarding', async () => {
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  const titleInput = await screen.findByRole('textbox', {
    name: 'Artifact title',
  })
  expect(titleInput).toHaveValue('Document One')

  await user.clear(titleInput)
  await user.type(titleInput, 'Renamed draft')
  expect(screen.getByText('Unsaved changes')).toBeVisible()

  await user.click(screen.getByRole('button', { name: /Document Two/ }))
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Keep editing' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(screen.getByRole('textbox', { name: 'Artifact title' })).toHaveValue(
    'Renamed draft'
  )

  await user.click(screen.getByRole('button', { name: /Document Two/ }))
  await user.click(
    await screen.findByRole('button', { name: 'Discard changes' })
  )
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Artifact title' })).toHaveValue(
      'Document Two'
    )
  )
  expect(screen.queryByText('Unsaved changes')).toBeNull()
})

test('closing the panel with unsaved changes asks before discarding', async () => {
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  const titleInput = await screen.findByRole('textbox', {
    name: 'Artifact title',
  })
  await user.type(titleInput, ' edited')

  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
})

test('closing the panel without changes does not ask', async () => {
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(onClose).toHaveBeenCalledTimes(1)
})
