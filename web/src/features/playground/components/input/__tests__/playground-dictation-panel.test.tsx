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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { PlaygroundDictationPanel } from '../playground-dictation-panel'

// The recorder is a browser API jsdom does not implement; the fake exposes the
// same start/stop contract the panel drives.
class FakeMediaRecorder {
  static isTypeSupported = () => true
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({
      data: new Blob(['dictated speech'], { type: 'audio/webm' }),
    })
    this.onstop?.()
  }
}

const getUserMediaMock = vi.fn()
const stopTrackMock = vi.fn()

beforeEach(() => {
  getUserMediaMock.mockReset()
  stopTrackMock.mockReset()
  getUserMediaMock.mockResolvedValue({
    getTracks: () => [{ stop: stopTrackMock }],
  })
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: getUserMediaMock },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: undefined,
  })
})

function renderPanel(onTranscript = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <PlaygroundDictationPanel
        group='default'
        models={[{ label: 'whisper-1', value: 'whisper-1' }]}
        onTranscript={onTranscript}
      />
    </QueryClientProvider>
  )
  return onTranscript
}

async function recordClip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Dictation' }))
  await user.click(screen.getByRole('button', { name: 'Start dictation' }))
  await user.click(
    await screen.findByRole('button', { name: 'Stop dictation' })
  )
}

test('a recording is transcribed through the playground bridge and inserted', async () => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { text: '  hello world  ' } })
  const user = userEvent.setup()
  const onTranscript = renderPanel()

  await recordClip(user)

  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('hello world'))

  expect(post.mock.calls[0][0]).toBe('/pg/audio/transcriptions')
  expect(post.mock.calls[0][1]).toBeInstanceOf(FormData)
  const form = post.mock.calls[0][1] as FormData
  expect(form.get('model')).toBe('whisper-1')
  expect((form.get('file') as File).name).toBe('dictation.webm')
  expect(post.mock.calls[0][2]).toMatchObject({
    headers: { 'X-Playground-Group': 'default' },
  })
  expect(stopTrackMock).toHaveBeenCalled()
})

test('an empty transcript never reaches the composer', async () => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.spyOn(api, 'post').mockResolvedValue({ data: { text: '   ' } })
  const user = userEvent.setup()
  const onTranscript = renderPanel()

  await recordClip(user)

  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Start dictation' })
    ).toBeEnabled()
  )
  expect(onTranscript).not.toHaveBeenCalled()
})

test('a failed transcription leaves the composer untouched', async () => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.spyOn(api, 'post').mockRejectedValue(new Error('Transcription failed'))
  const user = userEvent.setup()
  const onTranscript = renderPanel()

  await recordClip(user)

  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Start dictation' })
    ).toBeEnabled()
  )
  expect(onTranscript).not.toHaveBeenCalled()
})

test('an unsupported browser reports the missing recorder instead of recording', async () => {
  vi.stubGlobal('MediaRecorder', undefined)
  const post = vi.spyOn(api, 'post')
  const user = userEvent.setup()
  const onTranscript = renderPanel()

  await user.click(screen.getByRole('button', { name: 'Dictation' }))
  await user.click(screen.getByRole('button', { name: 'Start dictation' }))

  expect(getUserMediaMock).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
  expect(onTranscript).not.toHaveBeenCalled()
})
