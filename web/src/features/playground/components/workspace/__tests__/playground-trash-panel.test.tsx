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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { PlaygroundTrashPanel } from '../playground-trash-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const trashListing = {
  data: {
    success: true,
    data: {
      retention_days: 30,
      items: [
        {
          kind: 'session',
          id: 'pgs_one',
          title: 'Old conversation',
          deleted_at: 10,
          purge_at: 20,
        },
        {
          kind: 'canvas',
          id: 'pgc_one',
          title: 'Old canvas',
          deleted_at: 30,
          purge_at: 40,
        },
      ],
    },
  },
}

function mockTrashListing(response: unknown): void {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/playground/trash') return response as never
    throw new Error(`Unexpected request: ${url}`)
  })
}

afterEach(() => vi.restoreAllMocks())

test('lists trashed conversations and canvases with the retention window', async () => {
  mockTrashListing(trashListing)

  render(
    <PlaygroundTrashPanel
      onRestoreCanvas={vi.fn(async () => {})}
      onRestoreSession={vi.fn(async () => {})}
    />
  )

  expect(await screen.findByText('Old conversation')).toBeVisible()
  expect(screen.getByText('Old canvas')).toBeVisible()
  expect(
    screen.getByText(
      'Trashed items still count toward your storage and are removed after 30 days.'
    )
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Export Old conversation' })
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Export Old canvas' })).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Restore Old conversation' })
  ).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Restore Old canvas' })
  ).toBeVisible()
})

test('restoring an entry calls the matching handler and removes its row', async () => {
  mockTrashListing(trashListing)
  const user = userEvent.setup()
  const onRestoreSession = vi.fn(async () => {})
  const onRestoreCanvas = vi.fn(async () => {})

  render(
    <PlaygroundTrashPanel
      onRestoreCanvas={onRestoreCanvas}
      onRestoreSession={onRestoreSession}
    />
  )

  await user.click(
    await screen.findByRole('button', { name: 'Restore Old conversation' })
  )
  expect(onRestoreSession).toHaveBeenCalledWith('pgs_one')
  await waitFor(() =>
    expect(screen.queryByText('Old conversation')).not.toBeInTheDocument()
  )

  await user.click(screen.getByRole('button', { name: 'Restore Old canvas' }))
  expect(onRestoreCanvas).toHaveBeenCalledWith('pgc_one')
  await waitFor(() =>
    expect(screen.queryByText('Old canvas')).not.toBeInTheDocument()
  )
})

test('shows the empty state when nothing is trashed', async () => {
  mockTrashListing({
    data: {
      success: true,
      data: { retention_days: 30, items: [] },
    },
  })

  render(
    <PlaygroundTrashPanel
      onRestoreCanvas={vi.fn(async () => {})}
      onRestoreSession={vi.fn(async () => {})}
    />
  )

  expect(await screen.findByText('The trash is empty')).toBeVisible()
})

test('a failed load shows the error state and retry reads the trash again', async () => {
  let attempt = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url !== '/api/playground/trash') {
      throw new Error(`Unexpected request: ${url}`)
    }
    attempt += 1
    if (attempt === 1) throw new Error('Offline')
    return trashListing as never
  })
  const user = userEvent.setup()

  render(
    <PlaygroundTrashPanel
      onRestoreCanvas={vi.fn(async () => {})}
      onRestoreSession={vi.fn(async () => {})}
    />
  )

  expect(await screen.findByText('Unable to load the trash.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Old conversation')).toBeVisible()
})
