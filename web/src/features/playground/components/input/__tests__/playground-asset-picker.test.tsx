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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  PromptInputProvider,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { PlaygroundAssetPicker } from '../playground-asset-picker'

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

const attachmentAsset = {
  kind: 'attachment',
  id: 'pgf_1',
  session_id: 'pgs_1',
  title: 'sunset.png',
  media_type: 'image/png',
  byte_size: 2048,
  in_use: false,
  created_at: 100,
  updated_at: 100,
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

let testI18n: i18n

function ComposerFiles() {
  const attachments = usePromptInputAttachments()
  return (
    <ul aria-label='Composer files'>
      {attachments.files.map((file) => (
        <li key={file.id}>{file.filename}</li>
      ))}
    </ul>
  )
}

function renderPicker(onInsertText = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <PromptInputProvider>
          <PlaygroundAssetPicker onInsertText={onInsertText} />
          <ComposerFiles />
        </PromptInputProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
  return onInsertText
}

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  useAuthStore.getState().auth.setUser({ id: 7, username: 'tester', role: 1 })
  vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === '/api/playground/assets') {
      const params = (config?.params ?? {}) as { kind?: string }
      return {
        data: {
          success: true,
          data: {
            items:
              params.kind === 'artifact' ? [artifactAsset] : [attachmentAsset],
            total: 1,
            page: 1,
          },
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
})

afterEach(() => {
  useAuthStore.getState().auth.setUser(null)
  vi.restoreAllMocks()
})

test('the attachment layer adds a saved attachment to the message', async () => {
  const user = userEvent.setup()
  renderPicker()

  await user.click(screen.getByRole('button', { name: 'Attach' }))
  await user.click(screen.getByRole('tab', { name: 'My assets' }))
  expect(await screen.findByText('sunset.png')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Add to message' }))

  await waitFor(() =>
    expect(screen.getByLabelText('Composer files')).toHaveTextContent(
      'sunset.png'
    )
  )
  expect(api.get).toHaveBeenCalledWith(
    '/api/playground/assets',
    expect.objectContaining({
      params: expect.objectContaining({ kind: 'attachment' }),
    })
  )
})

test('the artifact tab inserts the artifact body into the draft', async () => {
  const user = userEvent.setup()
  const onInsertText = renderPicker()

  await user.click(screen.getByRole('button', { name: 'Attach' }))
  await user.click(screen.getByRole('tab', { name: 'My assets' }))
  await user.click(screen.getByRole('button', { name: 'Artifacts' }))
  expect(await screen.findByText('Notes')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Add to message' }))

  await waitFor(() =>
    expect(onInsertText).toHaveBeenCalledWith('Artifact body text')
  )
})
