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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { listCanvasSnapshots } from '../../api'
import { CanvasSnapshotHistory } from '../canvas-snapshot-history'

vi.mock('../../api', () => ({
  listCanvasSnapshots: vi.fn(),
}))

const snapshot = {
  id: 's1',
  canvasId: 'c1',
  revision: 12,
  nodeCount: 3,
  edgeCount: 1,
  byteSize: 2048,
  createdAt: 1_700_000_000_000,
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('restores the snapshot the user confirms', async () => {
  const user = userEvent.setup()
  const onRestore = vi.fn().mockResolvedValue(undefined)
  vi.mocked(listCanvasSnapshots).mockResolvedValue([snapshot])

  render(
    <CanvasSnapshotHistory
      open
      projectId='c1'
      onOpenChange={vi.fn()}
      onRestore={onRestore}
    />
  )

  expect(await screen.findByText('Version 12')).toBeVisible()
  expect(screen.getByText(/Nodes: 3/)).toBeVisible()
  expect(screen.getByText(/Edges: 1/)).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Restore version 12' }))
  const confirmation = await screen.findByRole('alertdialog')
  expect(confirmation).toHaveTextContent('Restore this version?')

  await user.click(
    within(confirmation).getByRole('button', { name: 'Restore' })
  )
  await waitFor(() => expect(onRestore).toHaveBeenCalledWith('s1'))
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
})

test('keeps the confirmation open when the restore fails', async () => {
  const user = userEvent.setup()
  const onRestore = vi.fn().mockRejectedValue(new Error('down'))
  vi.mocked(listCanvasSnapshots).mockResolvedValue([snapshot])

  render(
    <CanvasSnapshotHistory
      open
      projectId='c1'
      onOpenChange={vi.fn()}
      onRestore={onRestore}
    />
  )

  await user.click(
    await screen.findByRole('button', { name: 'Restore version 12' })
  )
  const confirmation = await screen.findByRole('alertdialog')
  await user.click(
    within(confirmation).getByRole('button', { name: 'Restore' })
  )

  await waitFor(() => expect(onRestore).toHaveBeenCalledWith('s1'))
  expect(screen.getByRole('alertdialog')).toBeVisible()
})

test('shows the empty state when no version is stored yet', async () => {
  vi.mocked(listCanvasSnapshots).mockResolvedValue([])

  render(
    <CanvasSnapshotHistory
      open
      projectId='c1'
      onOpenChange={vi.fn()}
      onRestore={vi.fn()}
    />
  )

  expect(await screen.findByText('No version history')).toBeVisible()
})

test('surfaces a retry when the history fails to load', async () => {
  const user = userEvent.setup()
  vi.mocked(listCanvasSnapshots)
    .mockRejectedValueOnce(new Error('down'))
    .mockResolvedValueOnce([snapshot])

  render(
    <CanvasSnapshotHistory
      open
      projectId='c1'
      onOpenChange={vi.fn()}
      onRestore={vi.fn()}
    />
  )

  await user.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Version 12')).toBeVisible()
})
