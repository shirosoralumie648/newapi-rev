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
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { submitAudioSpeech } from '../../generation-api'
import { useAutoReadAloud } from '../use-auto-read-aloud'

vi.mock('../../generation-api', () => ({
  submitAudioSpeech: vi.fn(),
}))

interface FakePlayback {
  paused: boolean
  played: boolean
}

const playbacks: FakePlayback[] = []

class FakeAudio {
  paused = false
  played = false

  constructor(public src: string) {}

  pause() {
    this.paused = true
  }

  play() {
    this.played = true
    playbacks.push(this)
    return Promise.resolve()
  }

  addEventListener() {
    // The playback lifetime is irrelevant to these assertions.
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  playbacks.length = 0
  vi.mocked(submitAudioSpeech).mockReset()
  vi.stubGlobal('Audio', FakeAudio)
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:auto-read'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('reads a completed reply through the speech route and plays the audio', async () => {
  vi.mocked(submitAudioSpeech).mockResolvedValue(new Blob(['audio']))
  const hook = renderHook(() =>
    useAutoReadAloud({
      enabled: true,
      sessionId: 'session-1',
      model: 'tts-1',
      group: 'default',
    })
  )

  act(() => hook.result.current.read('Finished answer'))

  await waitFor(() => expect(playbacks).toHaveLength(1))
  expect(submitAudioSpeech).toHaveBeenCalledWith(
    {
      model: 'tts-1',
      text: 'Finished answer',
      group: 'default',
      voice: 'alloy',
    },
    expect.any(AbortSignal)
  )
})

test('a superseded reply never plays after a newer reply starts', async () => {
  const first = deferred<Blob>()
  const second = deferred<Blob>()
  vi.mocked(submitAudioSpeech)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const hook = renderHook(() =>
    useAutoReadAloud({
      enabled: true,
      sessionId: 'session-1',
      model: 'tts-1',
      group: 'default',
    })
  )

  act(() => hook.result.current.read('First'))
  act(() => hook.result.current.read('Second'))
  await act(async () => {
    first.resolve(new Blob(['first']))
    await first.promise
  })
  expect(playbacks).toHaveLength(0)

  await act(async () => {
    second.resolve(new Blob(['second']))
    await second.promise
  })
  await waitFor(() => expect(playbacks).toHaveLength(1))
})

test('a reply that resolves after a conversation switch is discarded', async () => {
  const pending = deferred<Blob>()
  vi.mocked(submitAudioSpeech).mockReturnValue(pending.promise)
  const hook = renderHook(
    (props: { sessionId: string }) =>
      useAutoReadAloud({
        enabled: true,
        sessionId: props.sessionId,
        model: 'tts-1',
        group: 'default',
      }),
    { initialProps: { sessionId: 'session-1' } }
  )

  act(() => hook.result.current.read('Old conversation'))
  hook.rerender({ sessionId: 'session-2' })

  await act(async () => {
    pending.resolve(new Blob(['late']))
    await pending.promise
  })

  expect(playbacks).toHaveLength(0)
  const signal = vi.mocked(submitAudioSpeech).mock.calls[0][1]
  expect(signal?.aborted).toBe(true)
})

test('disabled or empty text never calls the speech route', () => {
  const disabled = renderHook(() =>
    useAutoReadAloud({
      enabled: false,
      sessionId: 'session-1',
      model: 'tts-1',
      group: 'default',
    })
  )
  const empty = renderHook(() =>
    useAutoReadAloud({
      enabled: true,
      sessionId: 'session-1',
      model: 'tts-1',
      group: 'default',
    })
  )

  act(() => disabled.result.current.read('No request'))
  act(() => empty.result.current.read('   '))

  expect(submitAudioSpeech).not.toHaveBeenCalled()
})
