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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import type { ComponentProps } from 'react'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { CanvasAssetLibrary } from '../canvas-asset-library'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => `blob:test-${Math.random()}`,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: () => undefined,
  })
}

const freeAttachment = {
  kind: 'attachment',
  id: 'pgf_free',
  session_id: 'pgs_1',
  title: 'sunset.png',
  media_type: 'image/png',
  byte_size: 2048,
  in_use: false,
  created_at: 100,
  updated_at: 100,
}

const pinnedAttachment = {
  kind: 'attachment',
  id: 'pgf_pinned',
  session_id: 'pgs_1',
  title: 'pinned.png',
  media_type: 'image/png',
  byte_size: 4096,
  in_use: true,
  created_at: 200,
  updated_at: 200,
}

const artifactAsset = {
  kind: 'artifact',
  id: 'pga_1',
  session_id: 'pgs_1',
  title: 'Notes',
  language: 'markdown',
  revision: 3,
  in_use: false,
  created_at: 50,
  updated_at: 300,
}

const artifactResult = {
  artifact: {
    id: 'pga_1',
    session_id: 'pgs_1',
    kind: 'markdown',
    revision: 3,
    current_version_id: 'pgv_1',
    title: 'Notes',
    language: 'markdown',
    created_at: 50,
    updated_at: 300,
  },
  version: {
    id: 'pgv_1',
    artifact_id: 'pga_1',
    number: 1,
    title: 'Notes',
    language: 'markdown',
    content: 'Artifact body text',
    byte_size: 18,
    created_at: 50,
  },
}

const tasks = [
  {
    id: 1,
    user_id: 7,
    platform: 'kling',
    task_id: 'task_alpha',
    action: 'GENERATE',
    channel_id: 1,
    group: 'default',
    quota: 0,
    submit_time: 10,
    status: 'SUCCESS',
    properties: { origin_model_name: 'kling-v1' },
  },
  {
    id: 2,
    user_id: 7,
    platform: 'sora',
    task_id: 'task_beta',
    action: 'GENERATE',
    channel_id: 1,
    group: 'default',
    quota: 0,
    submit_time: 11,
    status: 'SUCCESS',
    properties: { origin_model_name: 'sora-v2' },
  },
]

let testI18n: i18n

function mockLibraryApi() {
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/api/playground/assets') {
      const params = (config?.params ?? {}) as { kind?: string }
      if (params.kind === 'artifact') {
        return {
          data: {
            success: true,
            data: { items: [artifactAsset], total: 1, page: 1 },
          },
        }
      }
      return {
        data: {
          success: true,
          data: {
            items: [freeAttachment, pinnedAttachment],
            total: 2,
            page: 1,
          },
        },
      }
    }
    if (url.startsWith('/api/task/self')) {
      return {
        data: {
          success: true,
          data: { items: tasks, total: tasks.length, page: 1, page_size: 20 },
        },
      }
    }
    if (url === '/api/playground/sessions/pgs_1/artifacts/pga_1') {
      return { data: { success: true, data: artifactResult } }
    }
    if (url.endsWith('/content')) {
      return {
        data: new Blob([new Uint8Array([137, 80, 78, 71])], {
          type: 'image/png',
        }),
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  vi.spyOn(api, 'delete').mockResolvedValue({
    data: { success: true, data: null },
  })
}

function renderLibrary(
  overrides: Partial<ComponentProps<typeof CanvasAssetLibrary>> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const callbacks = {
    onOpenConversation: vi.fn(),
    onSendAttachmentToChat: vi.fn(),
    onSendArtifactToChat: vi.fn(),
    onSendSeedsToCanvas: vi.fn(),
    onSendToCanvas: vi.fn(),
  }
  const view = render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <CanvasAssetLibrary
          active
          userId={7}
          {...callbacks}
          {...overrides}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
  return { ...callbacks, ...view }
}

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

test('lists attachments and disables deleting a referenced attachment', async () => {
  mockLibraryApi()
  renderLibrary()

  expect(await screen.findByText('sunset.png')).toBeVisible()
  expect(screen.getByText('pinned.png')).toBeVisible()
  expect(screen.getByText('In use')).toBeVisible()
  expect(api.get).toHaveBeenCalledWith(
    '/api/playground/assets',
    expect.objectContaining({
      params: expect.objectContaining({
        kind: 'attachment',
        p: 1,
        page_size: 20,
      }),
    })
  )

  const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
  expect(deleteButtons).toHaveLength(2)
  expect(deleteButtons[0]).toBeEnabled()
  expect(deleteButtons[1]).toBeDisabled()
})

test('typing a search term queries the server-side filter', async () => {
  mockLibraryApi()
  const user = userEvent.setup()
  renderLibrary()

  await screen.findByText('sunset.png')
  await user.type(screen.getByLabelText('Search assets'), 'sunset')

  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      '/api/playground/assets',
      expect.objectContaining({
        params: expect.objectContaining({ search: 'sunset', p: 1 }),
      })
    )
  )
})

test('generation results reuse the owner-scoped task list and filter locally', async () => {
  mockLibraryApi()
  const user = userEvent.setup()
  renderLibrary()

  await user.click(screen.getByRole('button', { name: 'Generation results' }))

  expect(await screen.findByText('kling-v1')).toBeVisible()
  expect(screen.getByText('sora-v2')).toBeVisible()
  expect(api.get).toHaveBeenCalledWith(
    expect.stringContaining('/api/task/self')
  )

  await user.type(screen.getByLabelText('Search assets'), 'sora')
  await waitFor(() =>
    expect(screen.queryByText('kling-v1')).not.toBeInTheDocument()
  )
  expect(screen.getByText('sora-v2')).toBeVisible()
})

test('deleting an attachment calls its owner-scoped delete endpoint', async () => {
  mockLibraryApi()
  const user = userEvent.setup()
  renderLibrary()

  await screen.findByText('sunset.png')
  await user.click(screen.getAllByRole('button', { name: 'Delete' })[0])

  const dialog = await screen.findByRole('alertdialog', {
    name: 'Delete asset?',
  })
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(api.delete).toHaveBeenCalledWith(
      '/api/playground/sessions/pgs_1/attachments/pgf_free',
      expect.anything()
    )
  )
})

test('deleting an artifact sends the revision the library listed', async () => {
  mockLibraryApi()
  const user = userEvent.setup()
  renderLibrary()

  await user.click(screen.getByRole('button', { name: 'Artifacts' }))
  await screen.findByText('Notes')
  await user.click(screen.getByRole('button', { name: 'Delete' }))

  const dialog = await screen.findByRole('alertdialog', {
    name: 'Delete asset?',
  })
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(api.delete).toHaveBeenCalledWith(
      '/api/playground/sessions/pgs_1/artifacts/pga_1',
      expect.objectContaining({ params: { expected_revision: 3 } })
    )
  )
})

test('previewing an artifact loads its current version through the artifact endpoint', async () => {
  mockLibraryApi()
  const user = userEvent.setup()
  renderLibrary()

  await user.click(screen.getByRole('button', { name: 'Artifacts' }))
  await screen.findByText('Notes')
  await user.click(screen.getByRole('button', { name: 'Preview' }))

  const dialog = await screen.findByRole('dialog')
  expect(await within(dialog).findByText('Artifact body text')).toBeVisible()
  expect(api.get).toHaveBeenCalledWith(
    '/api/playground/sessions/pgs_1/artifacts/pga_1',
    expect.anything()
  )
})

test('card actions report the selected asset to the workspace', async () => {
  mockLibraryApi()
  const user = userEvent.setup()
  const callbacks = renderLibrary()

  const title = await screen.findByText('sunset.png')
  const card = title.closest('li')
  expect(card).not.toBeNull()
  const scope = within(card as HTMLElement)

  await user.click(scope.getByRole('button', { name: 'Send to chat' }))
  expect(callbacks.onSendAttachmentToChat).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'pgf_free', kind: 'attachment' })
  )

  await user.click(scope.getByRole('button', { name: 'Send to canvas' }))
  expect(callbacks.onSendToCanvas).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'pgf_free', kind: 'attachment' })
  )

  await user.click(scope.getByRole('button', { name: 'Open conversation' }))
  expect(callbacks.onOpenConversation).toHaveBeenCalledWith('pgs_1')
})

test('a failed listing shows the panel error state instead of an empty library', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Offline'))
  vi.spyOn(api, 'delete').mockResolvedValue({
    data: { success: true, data: null },
  })
  renderLibrary()

  expect(
    await screen.findByText('Unable to load the Playground asset library.')
  ).toBeVisible()
  expect(screen.queryByText('No assets yet')).not.toBeInTheDocument()
})
