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
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CanvasShareDialog } from '../canvas-share-dialog'

const createdShare = {
  data: {
    success: true,
    data: {
      token: 'canvas-token',
      url_path: '/share/canvas-token',
      expires_at: 0,
      created_at: 100,
    },
  },
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('creating a canvas link sends the selected expiry and shows the one-time URL', async () => {
  const user = userEvent.setup()
  const post = vi.spyOn(api, 'post').mockResolvedValue(createdShare)

  render(<CanvasShareDialog canvasId='pgc_one' title='Board' />)

  await user.click(screen.getByRole('button', { name: 'Share Board' }))
  await user.selectOptions(
    await screen.findByLabelText('Link expiration'),
    '30'
  )
  await user.click(screen.getByRole('button', { name: 'Create share link' }))

  const expectedURL = new URL('/share/canvas-token', window.location.origin)
  expect(await screen.findByLabelText('Share link')).toHaveValue(
    expectedURL.toString()
  )
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][0]).toBe('/api/playground/canvases/pgc_one/share')
  expect(post.mock.calls[0][1]).toEqual({ expires_in_days: 30 })
})

test('revoking an existing canvas link works before creating a new one', async () => {
  const user = userEvent.setup()
  const remove = vi.spyOn(api, 'delete').mockResolvedValue({
    data: { success: true, data: { revoked: true } },
  })

  render(<CanvasShareDialog canvasId='pgc_one' title='Board' />)

  await user.click(screen.getByRole('button', { name: 'Share Board' }))
  await user.click(await screen.findByRole('button', { name: 'Revoke link' }))

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/playground/canvases/pgc_one/share',
      expect.anything()
    )
  )
  expect(
    screen.getByRole('button', { name: 'Create share link' })
  ).toBeVisible()
})

test('revoking a canvas link clears the URL and offers creation again', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'post').mockResolvedValue(createdShare)
  const remove = vi.spyOn(api, 'delete').mockResolvedValue({
    data: { success: true, data: { revoked: true } },
  })

  render(<CanvasShareDialog canvasId='pgc_one' title='Board' />)

  await user.click(screen.getByRole('button', { name: 'Share Board' }))
  await user.click(screen.getByRole('button', { name: 'Create share link' }))
  await screen.findByLabelText('Share link')
  await user.click(screen.getByRole('button', { name: 'Revoke link' }))

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/playground/canvases/pgc_one/share',
      expect.anything()
    )
  )
  expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Create share link' })
  ).toBeVisible()
})
