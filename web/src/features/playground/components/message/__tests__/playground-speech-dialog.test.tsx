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
import { expect, test, vi } from 'vitest'

import { PlaygroundSpeechDialog } from '../playground-speech-dialog'

const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }))

vi.mock('../../../hooks', () => ({
  usePlaygroundGeneration: () => ({
    audio: { isPending: false, mutateAsync: generateMock },
  }),
}))

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
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

function renderDialog(onSave = vi.fn().mockResolvedValue(undefined)) {
  const onOpenChange = vi.fn()
  render(
    <PlaygroundSpeechDialog
      group='default'
      models={[{ label: 'tts-1', value: 'tts-1' }]}
      onOpenChange={onOpenChange}
      onSave={onSave}
      open
      text='Hello there'
    />
  )
  return { onOpenChange, onSave }
}

test('generating reads the message aloud and the save reports the audio bytes', async () => {
  const blob = new Blob(['audio bytes'], { type: 'audio/mpeg' })
  generateMock.mockReset()
  generateMock.mockResolvedValue(blob)
  const user = userEvent.setup()
  const { onOpenChange, onSave } = renderDialog()

  await user.click(screen.getByRole('button', { name: 'Generate' }))

  expect(generateMock).toHaveBeenCalledWith({
    model: 'tts-1',
    text: 'Hello there',
    group: 'default',
    voice: 'alloy',
  })
  expect(await screen.findByLabelText('Generated audio')).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Save to conversation' }))

  await waitFor(() => expect(onSave).toHaveBeenCalledWith(blob))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('saving stays unavailable until speech was generated', () => {
  generateMock.mockReset()
  renderDialog()

  expect(
    screen.getByRole('button', { name: 'Save to conversation' })
  ).toBeDisabled()
  expect(screen.queryByLabelText('Generated audio')).toBeNull()
})

test('a failed generation offers no audio to save', async () => {
  generateMock.mockReset()
  generateMock.mockRejectedValue(new Error('Offline'))
  const user = userEvent.setup()
  renderDialog()

  await user.click(screen.getByRole('button', { name: 'Generate' }))

  await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1))
  expect(screen.queryByLabelText('Generated audio')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Save to conversation' })
  ).toBeDisabled()
})
