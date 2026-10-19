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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'

import {
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  DEFAULT_CONTEXT_SETTINGS,
} from '../../../constants'
import { planPlaygroundContext } from '../../../lib'
import { PlaygroundInput } from '../playground-input'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

function buildInputElement(
  onSubmit: ComponentProps<typeof PlaygroundInput>['onSubmit'],
  overrides: Partial<ComponentProps<typeof PlaygroundInput>> = {}
) {
  const props: ComponentProps<typeof PlaygroundInput> = {
    autoReadDefaultEnabled: false,
    autoReadEnabled: false,
    autoReadHasOverride: false,
    compareModels: [],
    config: DEFAULT_CONFIG,
    contextPlan: planPlaygroundContext({
      messages: [],
      settings: DEFAULT_CONTEXT_SETTINGS,
    }),
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    contextSummary: null,
    groupValue: 'default',
    groups: [{ label: 'default', value: 'default', ratio: 1, desc: '' }],
    modelValue: 'gpt-4o',
    models: [{ label: 'gpt-4o', value: 'gpt-4o' }],
    onAutoReadChange: () => undefined,
    onAutoReadDefaultChange: () => undefined,
    onAutoReadUseDefault: () => undefined,
    onCompareModelsChange: () => undefined,
    onConfigChange: () => undefined,
    onContextSettingsChange: () => undefined,
    onGroupChange: () => undefined,
    onModelChange: () => undefined,
    onParameterEnabledChange: () => undefined,
    onRemoveContextSummary: () => undefined,
    onSubmit,
    onSummarizeContext: () => undefined,
    onSystemPromptChange: () => undefined,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    systemPrompt: '',
    ...overrides,
  }
  return <PlaygroundInput {...props} />
}

// The composer mounts the dictation panel, whose transcription mutation needs
// the query client the app installs at its root.
function renderComposer(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function QueryClientWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(ui, { wrapper: QueryClientWrapper })
}

function renderInput(
  onSubmit: ComponentProps<typeof PlaygroundInput>['onSubmit'] = vi
    .fn()
    .mockResolvedValue(undefined)
) {
  renderComposer(buildInputElement(onSubmit))
  return onSubmit
}

function attachmentFile() {
  return new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', {
    type: 'image/png',
  })
}

// jsdom's Blob cannot be passed to undici's Response (cross-realm), so the
// stub only needs the blob() surface the converter uses.
function stubBlobFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      blob: async () =>
        new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    }))
  )
}

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    Attach: 'Attach',
    'Ask anything': 'Ask anything',
    Send: 'Send',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
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

function sendButton(): HTMLElement {
  // Both responsive layouts render a send button; jsdom applies no CSS, so
  // scope to the first one instead of relying on visibility.
  return screen.getAllByRole('button', { name: /Send/ })[0]
}

test('an attachment-only message submits once the file is added', async () => {
  const user = userEvent.setup()
  stubBlobFetch()
  const onSubmit = renderInput()

  fireEvent.change(screen.getByLabelText('Upload files'), {
    target: { files: [attachmentFile()] },
  })
  expect(await screen.findByText('photo.png')).toBeVisible()

  expect(sendButton()).toBeEnabled()
  await user.click(sendButton())

  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  const [text, files] = vi.mocked(onSubmit).mock.calls[0]
  expect(text).toBe('')
  expect(files).toHaveLength(1)
  expect(files[0].filename).toBe('photo.png')
  expect(files[0].id).toBeTruthy()
  expect(files[0].url.startsWith('data:image/png')).toBe(true)
})

test('text-only messages keep the existing submit shape', async () => {
  const user = userEvent.setup()
  const onSubmit = renderInput()
  expect(sendButton()).toBeDisabled()

  await user.type(screen.getByPlaceholderText('Ask anything'), 'hello')
  await user.click(sendButton())

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('hello', []))
})

test('a failed send keeps the draft text and attachment for retry', async () => {
  const user = userEvent.setup()
  stubBlobFetch()
  const onSubmit = vi.fn().mockRejectedValue(new Error('upload failed'))
  renderInput(onSubmit)

  fireEvent.change(screen.getByLabelText('Upload files'), {
    target: { files: [attachmentFile()] },
  })
  await screen.findByText('photo.png')
  await user.type(screen.getByPlaceholderText('Ask anything'), 'keep me')
  await user.click(sendButton())

  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(screen.getByPlaceholderText('Ask anything')).toHaveValue('keep me')
  expect(screen.getByText('photo.png')).toBeVisible()
})

test('pending files from the library join the composer exactly once', async () => {
  const onPendingFilesConsumed = vi.fn()
  const pending = [attachmentFile()]
  const { rerender } = renderComposer(
    buildInputElement(vi.fn().mockResolvedValue(undefined), {
      pendingFiles: pending,
      onPendingFilesConsumed,
    })
  )

  expect(await screen.findByText('photo.png')).toBeVisible()
  expect(onPendingFilesConsumed).toHaveBeenCalledTimes(1)

  // A parent re-render with the same batch must not add the file again.
  rerender(
    buildInputElement(vi.fn().mockResolvedValue(undefined), {
      pendingFiles: pending,
      onPendingFilesConsumed,
    })
  )
  expect(screen.getAllByText('photo.png')).toHaveLength(1)
  expect(onPendingFilesConsumed).toHaveBeenCalledTimes(1)
})

test('pending artifact text is appended to the draft once', async () => {
  const user = userEvent.setup()
  const onPendingTextConsumed = vi.fn()
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  const { rerender } = renderComposer(buildInputElement(onSubmit))

  await user.type(screen.getByPlaceholderText('Ask anything'), 'Draft')
  rerender(
    buildInputElement(onSubmit, {
      pendingText: 'artifact body',
      onPendingTextConsumed,
    })
  )

  await waitFor(() =>
    expect(screen.getByPlaceholderText('Ask anything')).toHaveValue(
      'Draft\n\nartifact body'
    )
  )
  expect(onPendingTextConsumed).toHaveBeenCalledTimes(1)
})
