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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import {
  CanvasImageToolsDialog,
  type CanvasImageToolsDialogProps,
} from '../canvas-image-tools-dialog'

const SOURCE = 'data:image/png;base64,iVBORw0KGgo='

/** jsdom implements neither PointerEvent nor pointer capture. */
function pointerGeometry() {
  class TestPointerEvent extends MouseEvent {
    pointerId: number

    constructor(type: string, init: PointerEventInit) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  for (const name of [
    'setPointerCapture',
    'releasePointerCapture',
    'hasPointerCapture',
  ]) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: () => false,
    })
  }
}

// The prototype overrides above outlive vi.unstubAllGlobals, so the original
// descriptors are saved and restored per test.
const POINTER_CAPTURE_METHODS = [
  'setPointerCapture',
  'releasePointerCapture',
  'hasPointerCapture',
] as const

const originalPointerCaptureMethods = POINTER_CAPTURE_METHODS.map(
  (name) =>
    [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
    ] as const
)

function surfaceRect(surface: HTMLElement, rect: DOMRect) {
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(rect)
}

function renderDialog(overrides: Partial<CanvasImageToolsDialogProps> = {}) {
  const onClose = vi.fn()
  const onCrop = vi.fn(async () => true)
  const onRedraw = vi.fn(async () => true)
  const onUpscale = vi.fn(async () => true)
  const view = render(
    <CanvasImageToolsDialog
      busy={false}
      models={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
      onClose={onClose}
      onCrop={onCrop}
      onRedraw={onRedraw}
      onUpscale={onUpscale}
      source={SOURCE}
      sourceSize={{ width: 1000, height: 500 }}
      tool='crop'
      {...overrides}
    />
  )
  // The dialog is portaled to the document, so the preview is queried from the
  // base element rather than the render container.
  const image = view.baseElement.querySelector('img')
  const surface = image?.parentElement ?? null
  return { ...view, image, surface, onClose, onCrop, onRedraw, onUpscale }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of originalPointerCaptureMethods) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  }
})

test('the crop dialog starts on the whole image and applies the typed rectangle', async () => {
  const user = userEvent.setup()
  const { onCrop } = renderDialog()

  const width = await screen.findByLabelText('Crop width (px)')
  expect(width).toHaveValue(1000)
  expect(screen.getByLabelText('Crop height (px)')).toHaveValue(500)
  expect(screen.getByLabelText('Crop left (px)')).toHaveValue(0)

  await user.clear(width)
  await user.type(width, '400')
  await user.click(screen.getByRole('button', { name: 'Apply crop' }))

  await waitFor(() =>
    expect(onCrop).toHaveBeenCalledWith({ x: 0, y: 0, width: 400, height: 500 })
  )
})

test('the crop apply button stays disabled until the rectangle reaches the minimum edge', async () => {
  const user = userEvent.setup()
  const { onCrop } = renderDialog()

  const width = await screen.findByLabelText('Crop width (px)')
  await user.clear(width)
  await user.type(width, '4')

  const apply = screen.getByRole('button', { name: 'Apply crop' })
  expect(apply).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Select full image' }))
  expect(apply).toBeEnabled()
  expect(onCrop).not.toHaveBeenCalled()
})

test('dragging over the crop preview maps the displayed rectangle onto the source', async () => {
  pointerGeometry()
  const user = userEvent.setup()
  const { image, surface, onCrop } = renderDialog()
  expect(image).not.toBeNull()
  expect(surface).not.toBeNull()
  surfaceRect(surface as HTMLElement, new DOMRect(0, 0, 250, 125))

  fireEvent.pointerDown(image as Element, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
  })
  fireEvent.pointerMove(image as Element, {
    pointerId: 1,
    clientX: 100,
    clientY: 50,
  })
  fireEvent.pointerUp(image as Element, {
    pointerId: 1,
    clientX: 100,
    clientY: 50,
  })

  await user.click(screen.getByRole('button', { name: 'Apply crop' }))
  await waitFor(() =>
    expect(onCrop).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    })
  )
})

test('the redraw dialog needs a painted mask, a prompt and a model before applying', async () => {
  pointerGeometry()
  const user = userEvent.setup()
  const { image, surface, onRedraw } = renderDialog({ tool: 'redraw' })
  expect(image).not.toBeNull()
  expect(surface).not.toBeNull()

  const apply = screen.getByRole('button', { name: 'Apply redraw' })
  expect(apply).toBeDisabled()

  surfaceRect(surface as HTMLElement, new DOMRect(0, 0, 200, 100))
  fireEvent.pointerDown(image as Element, {
    pointerId: 1,
    button: 0,
    clientX: 20,
    clientY: 10,
  })
  fireEvent.pointerMove(image as Element, {
    pointerId: 1,
    clientX: 40,
    clientY: 20,
  })
  fireEvent.pointerUp(image as Element, {
    pointerId: 1,
    clientX: 40,
    clientY: 20,
  })
  expect(apply).toBeDisabled()

  await user.type(screen.getByLabelText('Describe the change'), 'add a hat')
  expect(apply).toBeEnabled()

  await user.click(apply)
  await waitFor(() =>
    expect(onRedraw).toHaveBeenCalledWith({
      prompt: 'add a hat',
      model: 'gpt-image-1',
      strokes: [
        {
          size: 24,
          points: [
            { x: 100, y: 50 },
            { x: 200, y: 100 },
          ],
        },
      ],
    })
  )
})

test('the redraw dialog clears a painted mask on demand', async () => {
  pointerGeometry()
  const user = userEvent.setup()
  const { image, surface } = renderDialog({ tool: 'redraw' })
  surfaceRect(surface as HTMLElement, new DOMRect(0, 0, 200, 100))

  fireEvent.pointerDown(image as Element, {
    pointerId: 1,
    button: 0,
    clientX: 20,
    clientY: 10,
  })
  fireEvent.pointerUp(image as Element, {
    pointerId: 1,
    clientX: 20,
    clientY: 10,
  })

  await user.type(screen.getByLabelText('Describe the change'), 'add a hat')
  const apply = screen.getByRole('button', { name: 'Apply redraw' })
  expect(apply).toBeEnabled()

  await user.click(screen.getByRole('button', { name: 'Clear mask' }))
  expect(apply).toBeDisabled()
})

test('the upscale dialog applies the preset factor', async () => {
  const user = userEvent.setup()
  const { onUpscale } = renderDialog({ tool: 'upscale' })

  const factor = await screen.findByLabelText('Scale factor')
  expect(factor).toHaveValue('2')

  await user.selectOptions(factor, '4')
  await user.click(screen.getByRole('button', { name: 'Apply upscale' }))

  await waitFor(() => expect(onUpscale).toHaveBeenCalledWith(4))
})

test('an image already at the edge limit cannot upscale', async () => {
  renderDialog({
    tool: 'upscale',
    sourceSize: { width: 4096, height: 4096 },
  })

  expect(
    await screen.findByText(
      'The image cannot be upscaled within the 4096-pixel limit.'
    )
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Apply upscale' })).toBeDisabled()
})

test('while busy the dialog cannot be closed or applied', async () => {
  const user = userEvent.setup()
  const { onClose, onCrop } = renderDialog({ busy: true })

  expect(
    await screen.findByRole('button', { name: 'Apply crop' })
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).not.toHaveBeenCalled()
  expect(onCrop).not.toHaveBeenCalled()
})

test('the dialog reports a source that is still loading', async () => {
  const { container } = renderDialog({ source: null, sourceSize: null })

  expect(await screen.findByText('Loading image...')).toBeVisible()
  expect(container.querySelector('img')).toBeNull()
})
