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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ImageDialog } from '../image-dialog'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/http-client', () => ({
  api: { get },
}))

const createObjectURL = vi.fn(() => 'blob:mj-image')

beforeEach(() => {
  get.mockReset()
  createObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

function renderDialog(imageUrl: string) {
  render(
    <ImageDialog
      imageUrl={imageUrl}
      taskId='mj-task-1'
      open
      onOpenChange={() => undefined}
    />
  )
}

test('loads a /mj/image link with the authenticated client before rendering it', async () => {
  get.mockResolvedValue({
    data: new Blob(['png-bytes'], { type: 'image/png' }),
  })

  renderDialog('/mj/image/mj-task-1')

  // The raw protected link must never reach the <img> element, because a plain
  // image request carries no credentials and would be rejected.
  expect(screen.queryByRole('img', { name: 'Generated image' })).toBeNull()
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/mj/image/mj-task-1',
      expect.objectContaining({
        responseType: 'blob',
        skipErrorHandler: true,
        disableDuplicate: true,
      })
    )
  )

  const image = await screen.findByRole('img', { name: 'Generated image' })
  await waitFor(() => expect(image).toHaveAttribute('src', 'blob:mj-image'))
})

test('keeps other image URLs on the direct <img> path without a credentialed request', async () => {
  renderDialog('https://cdn.example.com/generated.png')

  const image = await screen.findByRole('img', { name: 'Generated image' })
  expect(image).toHaveAttribute('src', 'https://cdn.example.com/generated.png')
  expect(get).not.toHaveBeenCalled()
})

test('reports a failed credentialed fetch instead of a broken image', async () => {
  get.mockRejectedValue(new Error('unauthorized'))

  renderDialog('/mj/image/mj-task-1')

  expect(await screen.findByText('Failed to load image')).toBeVisible()
  expect(screen.queryByRole('img', { name: 'Generated image' })).toBeNull()
  expect(createObjectURL).not.toHaveBeenCalled()
})
