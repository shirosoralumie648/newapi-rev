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
import { describe, expect, test } from 'vitest'

import type { ChatCompletionRequest } from '../types'
import { createStreamRequestController } from './use-stream-request'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

class FakeStreamSource {
  readyState = 0
  closed = false
  streamed = false
  xhr: { getResponseHeader: (name: string) => string | null } | null = null
  private listeners = new Map<
    string,
    Array<(event: Event & { data?: string; readyState?: number }) => void>
  >()

  addEventListener(
    type: string,
    listener: (event: Event & { data?: string; readyState?: number }) => void
  ) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {
    this.closed = true
  }

  stream() {
    this.streamed = true
  }

  emit(type: string, data?: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, readyState: this.readyState } as Event & {
        data?: string
        readyState?: number
      })
    }
  }

  emitReadyState(readyState: number) {
    this.readyState = readyState
    this.emit('readystatechange')
  }
}

const payload: ChatCompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
}

const noopCallbacks = {
  onUpdate: () => undefined,
  onToolCalls: () => undefined,
  onRequestId: () => undefined,
  onUsage: () => undefined,
  onComplete: () => undefined,
  onError: () => undefined,
}

describe('latest-wins stream request coordination', () => {
  test('only creates a stream for the latest header request', async () => {
    const firstHeaders = deferred<Record<string, string>>()
    const secondHeaders = deferred<Record<string, string>>()
    let headerRequest = 0
    const sources: FakeStreamSource[] = []
    const controller = createStreamRequestController({
      getHeaders: () => {
        headerRequest += 1
        return headerRequest === 1
          ? firstHeaders.promise
          : secondHeaders.promise
      },
      createSource: () => {
        const source = new FakeStreamSource()
        sources.push(source)
        return source
      },
      setStreaming: () => undefined,
    })

    const first = controller.send(payload, noopCallbacks)
    const second = controller.send(payload, noopCallbacks)
    firstHeaders.resolve({ Authorization: 'Bearer stale' })
    await first
    expect(sources.length).toBe(0)

    secondHeaders.resolve({ Authorization: 'Bearer current' })
    await second
    expect(sources.length).toBe(1)
    expect(sources[0]?.streamed).toBe(true)
  })

  test('stop cancels a request that is still waiting for headers', async () => {
    const headers = deferred<Record<string, string>>()
    let sourceCount = 0
    const controller = createStreamRequestController({
      getHeaders: () => headers.promise,
      createSource: () => {
        sourceCount += 1
        return new FakeStreamSource()
      },
      setStreaming: () => undefined,
    })

    const request = controller.send(payload, noopCallbacks)
    controller.stop()
    headers.resolve({ Authorization: 'Bearer ignored' })
    await request

    expect(sourceCount).toBe(0)
  })

  test('dispose cancels a pending header request without a state update', async () => {
    const headers = deferred<Record<string, string>>()
    const streamingStates: boolean[] = []
    let sourceCount = 0
    const controller = createStreamRequestController({
      getHeaders: () => headers.promise,
      createSource: () => {
        sourceCount += 1
        return new FakeStreamSource()
      },
      setStreaming: (streaming) => streamingStates.push(streaming),
    })

    const request = controller.send(payload, noopCallbacks)
    controller.dispose()
    headers.resolve({ Authorization: 'Bearer ignored' })
    await request

    expect(sourceCount).toBe(0)
    expect(streamingStates).toEqual([false])
  })

  test('closes the previous source and ignores all of its later events', async () => {
    const nextHeaders = deferred<Record<string, string>>()
    let headerRequest = 0
    const sources: FakeStreamSource[] = []
    const updates: string[] = []
    const controller = createStreamRequestController({
      getHeaders: () => {
        headerRequest += 1
        if (headerRequest === 1) {
          return Promise.resolve({ Authorization: 'Bearer first' })
        }
        return nextHeaders.promise
      },
      createSource: () => {
        const source = new FakeStreamSource()
        sources.push(source)
        return source
      },
      setStreaming: () => undefined,
    })
    const callbacks = {
      onUpdate: (_type: 'reasoning' | 'content', chunk: string) =>
        updates.push(chunk),
      onToolCalls: () => undefined,
      onRequestId: () => undefined,
      onUsage: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
    }

    await controller.send(payload, callbacks)
    const second = controller.send(payload, callbacks)
    expect(sources[0]?.closed).toBe(true)
    sources[0]?.emit(
      'message',
      JSON.stringify({ choices: [{ delta: { content: 'stale' } }] })
    )

    nextHeaders.resolve({ Authorization: 'Bearer second' })
    await second
    sources[1]?.emit(
      'message',
      JSON.stringify({ choices: [{ delta: { content: 'current' } }] })
    )

    expect(updates).toEqual(['current'])
  })

  test('dispatches streamed tool call fragments separately from text updates', async () => {
    const source = new FakeStreamSource()
    const updates: string[] = []
    const toolCallDeltas: unknown[] = []
    const controller = createStreamRequestController({
      getHeaders: () => Promise.resolve({ Authorization: 'Bearer test' }),
      createSource: () => source,
      setStreaming: () => undefined,
    })

    await controller.send(payload, {
      onUpdate: (_type, chunk) => updates.push(chunk),
      onToolCalls: (deltas) => toolCallDeltas.push(...deltas),
      onRequestId: () => undefined,
      onUsage: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
    })

    source.emit(
      'message',
      JSON.stringify({
        choices: [
          {
            delta: {
              content: 'checking',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'get_weather', arguments: '{"city"' },
                },
              ],
            },
          },
        ],
      })
    )
    source.emit(
      'message',
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }],
            },
          },
        ],
      })
    )

    expect(updates).toEqual(['checking'])
    expect(toolCallDeltas).toEqual([
      {
        index: 0,
        id: 'call_1',
        function: { name: 'get_weather', arguments: '{"city"' },
      },
      { index: 0, function: { arguments: ':"Paris"}' } },
    ])
  })

  test('reports the relay request id once and the final usage frame', async () => {
    const source = new FakeStreamSource()
    source.xhr = {
      getResponseHeader: (name) =>
        name === 'X-Oneapi-Request-Id' ? 'req-stream-1' : null,
    }
    const requestIds: string[] = []
    const usages: unknown[] = []
    const completed: number[] = []
    const controller = createStreamRequestController({
      getHeaders: () => Promise.resolve({ Authorization: 'Bearer test' }),
      createSource: () => source,
      setStreaming: () => undefined,
    })

    await controller.send(payload, {
      onUpdate: () => undefined,
      onToolCalls: () => undefined,
      onRequestId: (requestId) => requestIds.push(requestId),
      onUsage: (usage) => usages.push(usage),
      onComplete: () => completed.push(1),
      onError: () => undefined,
    })

    // The headers arrive before the body, so the id is known early; repeating
    // the state change must not report it twice.
    source.emitReadyState(1)
    source.emitReadyState(1)
    source.emit(
      'message',
      JSON.stringify({
        choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }],
      })
    )
    // The usage frame carries no choices; it is the last frame before [DONE].
    source.emit(
      'message',
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      })
    )
    source.emit('message', '[DONE]')

    expect(requestIds).toEqual(['req-stream-1'])
    expect(usages).toEqual([
      { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    ])
    expect(completed).toEqual([1])
  })

  test('reports the provider finish reason of the final data frame', async () => {
    const source = new FakeStreamSource()
    const finishReasons: string[] = []
    const controller = createStreamRequestController({
      getHeaders: () => Promise.resolve({ Authorization: 'Bearer test' }),
      createSource: () => source,
      setStreaming: () => undefined,
    })

    await controller.send(payload, {
      onUpdate: () => undefined,
      onToolCalls: () => undefined,
      onRequestId: () => undefined,
      onUsage: () => undefined,
      onFinishReason: (finishReason) => finishReasons.push(finishReason),
      onComplete: () => undefined,
      onError: () => undefined,
    })
    source.emit(
      'message',
      JSON.stringify({
        choices: [
          {
            delta: { content: 'The answer was cut' },
            finish_reason: 'length',
          },
        ],
      })
    )
    source.emit('message', '[DONE]')

    expect(finishReasons).toEqual(['length'])
  })

  test('captures the request id from the done frame when no state change fired', async () => {
    const source = new FakeStreamSource()
    source.xhr = {
      getResponseHeader: () => 'req-stream-2',
    }
    const requestIds: string[] = []
    const controller = createStreamRequestController({
      getHeaders: () => Promise.resolve({ Authorization: 'Bearer test' }),
      createSource: () => source,
      setStreaming: () => undefined,
    })

    await controller.send(payload, {
      onUpdate: () => undefined,
      onToolCalls: () => undefined,
      onRequestId: (requestId) => requestIds.push(requestId),
      onUsage: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
    })
    source.emit('message', '[DONE]')

    expect(requestIds).toEqual(['req-stream-2'])
  })

  test('ignores the request id of a superseded stream', async () => {
    const nextHeaders = deferred<Record<string, string>>()
    let headerRequest = 0
    const sources: FakeStreamSource[] = []
    const requestIds: string[] = []
    const controller = createStreamRequestController({
      getHeaders: () => {
        headerRequest += 1
        if (headerRequest === 1) {
          return Promise.resolve({ Authorization: 'Bearer first' })
        }
        return nextHeaders.promise
      },
      createSource: () => {
        const source = new FakeStreamSource()
        // The relay request id is fixed when the source is created; reading
        // the list length later would label an earlier stream with a newer id.
        const requestNumber = sources.length + 1
        source.xhr = { getResponseHeader: () => `req-${requestNumber}` }
        sources.push(source)
        return source
      },
      setStreaming: () => undefined,
    })
    const callbacks = {
      onUpdate: () => undefined,
      onToolCalls: () => undefined,
      onRequestId: (requestId: string) => requestIds.push(requestId),
      onUsage: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
    }

    await controller.send(payload, callbacks)
    const second = controller.send(payload, callbacks)
    sources[0]?.emitReadyState(1)

    nextHeaders.resolve({ Authorization: 'Bearer second' })
    await second
    sources[1]?.emitReadyState(1)

    expect(requestIds).toEqual(['req-2'])
  })
})
