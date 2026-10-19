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
import { afterEach, expect, test, vi } from 'vitest'

import type { CanvasPngExportResult } from '../../lib/canvas-export'
import { CanvasPngExportDialog } from '../canvas-png-export-dialog'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

// jsdom does not implement object URLs; define them so each test can spy on
// the same API the dialog uses.
if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => 'blob:preview',
  })
}
if (typeof URL.revokeObjectURL !== 'function') {
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: () => undefined,
  })
}

const RESULT: CanvasPngExportResult = {
  blob: new Blob(['png'], { type: 'image/png' }),
  width: 640,
  height: 440,
  scope: 'canvas',
  filename: 'Board.png',
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('previews the rendered board and runs download and save actions', async () => {
  const user = userEvent.setup()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const onDownload = vi.fn()
  const onSave = vi.fn()

  render(
    <CanvasPngExportDialog
      onDownload={onDownload}
      onOpenChange={() => undefined}
      onSave={onSave}
      open
      result={RESULT}
      saved={false}
      saving={false}
    />
  )

  expect(screen.getByRole('img', { name: 'PNG preview' })).toHaveAttribute(
    'src',
    'blob:preview'
  )
  expect(screen.getByText('640 × 440 px')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Download PNG' }))
  await user.click(screen.getByRole('button', { name: 'Save to library' }))
  expect(onDownload).toHaveBeenCalledTimes(1)
  expect(onSave).toHaveBeenCalledTimes(1)
})

test('shows the saved state and disables a second library save', () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

  render(
    <CanvasPngExportDialog
      onDownload={() => undefined}
      onOpenChange={() => undefined}
      onSave={() => undefined}
      open
      result={RESULT}
      saved
      saving={false}
    />
  )

  expect(
    screen.getByRole('button', { name: 'Saved to library' })
  ).toBeDisabled()
})
