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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import type { ComponentProps } from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { PlaygroundInput } from '../playground-input'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

function renderInput(
  onSubmit: ComponentProps<typeof PlaygroundInput>['onSubmit'] = vi
    .fn()
    .mockResolvedValue(undefined)
) {
  render(
    <PlaygroundInput
      config={DEFAULT_CONFIG}
      groupValue='default'
      groups={[{ label: 'default', value: 'default', ratio: 1, desc: '' }]}
      modelValue='gpt-4o'
      models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
      onConfigChange={() => undefined}
      onGroupChange={() => undefined}
      onModelChange={() => undefined}
      onParameterEnabledChange={() => undefined}
      onSubmit={onSubmit}
      parameterEnabled={DEFAULT_PARAMETER_ENABLED}
    />
  )
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
