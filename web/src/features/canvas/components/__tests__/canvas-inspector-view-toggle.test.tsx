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

import { CanvasInspectorViewToggle } from '../canvas-inspector-view-toggle'

test('marks the current view and reports the view the user picks', async () => {
  const user = userEvent.setup()
  const onViewChange = vi.fn()
  render(
    <CanvasInspectorViewToggle onViewChange={onViewChange} view='details' />
  )

  const details = screen.getByRole('button', { name: 'Node details' })
  const assistant = screen.getByRole('button', { name: 'Assistant' })
  expect(details).toHaveAttribute('aria-pressed', 'true')
  expect(assistant).toHaveAttribute('aria-pressed', 'false')

  await user.click(assistant)
  expect(onViewChange).toHaveBeenCalledTimes(1)
  expect(onViewChange).toHaveBeenCalledWith('assistant')
})

test('offers the creation-domain panels the canvas owns', async () => {
  const user = userEvent.setup()
  const onViewChange = vi.fn()
  render(
    <CanvasInspectorViewToggle onViewChange={onViewChange} view='details' />
  )

  for (const name of ['Generate', 'Library', 'Artifacts', 'Run history']) {
    await user.click(screen.getByRole('button', { name }))
  }

  expect(onViewChange).toHaveBeenNthCalledWith(1, 'generate')
  expect(onViewChange).toHaveBeenNthCalledWith(2, 'library')
  expect(onViewChange).toHaveBeenNthCalledWith(3, 'artifacts')
  expect(onViewChange).toHaveBeenNthCalledWith(4, 'history')
})
