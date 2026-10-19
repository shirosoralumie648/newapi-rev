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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { CanvasViewportControlsView } from '../canvas-viewport-controls'

test('shows the zoom percentage and routes every viewport action', async () => {
  const user = userEvent.setup()
  const actions = {
    onFitView: vi.fn(),
    onResetZoom: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
  }
  render(<CanvasViewportControlsView zoom={0.755} {...actions} />)

  expect(
    screen.getByRole('button', { name: 'Reset zoom to 100%' })
  ).toHaveTextContent('76%')

  await user.click(screen.getByRole('button', { name: 'Zoom in' }))
  await user.click(screen.getByRole('button', { name: 'Zoom out' }))
  await user.click(screen.getByRole('button', { name: 'Reset zoom to 100%' }))
  await user.click(screen.getByRole('button', { name: 'Fit view' }))

  expect(actions.onZoomIn).toHaveBeenCalledTimes(1)
  expect(actions.onZoomOut).toHaveBeenCalledTimes(1)
  expect(actions.onResetZoom).toHaveBeenCalledTimes(1)
  expect(actions.onFitView).toHaveBeenCalledTimes(1)
})
