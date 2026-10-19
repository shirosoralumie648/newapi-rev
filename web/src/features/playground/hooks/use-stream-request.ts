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
import { useCallback, useEffect, useRef, useState } from 'react'
import { SSE } from 'sse.js'

import { getFreshAuthHeaders } from '@/lib/api'

import {
  API_ENDPOINTS,
  ERROR_MESSAGES,
  PLAYGROUND_ANTHROPIC_VERSION,
  PLAYGROUND_CAPTURED_RESPONSE_MAX_CHARS,
  PLAYGROUND_REQUEST_ID_HEADER,
} from '../constants'
import {
  createPlaygroundProtocolStreamParser,
  getStreamReadyStateError,
  getStreamResponseRequestId,
  isStreamClosedReadyState,
  isStreamDoneMessage,
  parseStreamChunk,
  parseStreamErrorDetails,
  type PlaygroundProtocolRequest,
} from '../lib'
import type {
  ChatCompletionRequest,
  ChatCompletionToolCallDelta,
  MessageUsage,
} from '../types'

interface StreamEventSource {
  readyState?: number
  addEventListener: (
    type: string,
    listener: (event: Event & { data?: string; readyState?: number }) => void
  ) => void
  close: () => void
  stream: () => void
}

export interface StreamRequestCallbacks {
  onUpdate: (type: 'reasoning' | 'content', chunk: string) => void
  onToolCalls: (deltas: ChatCompletionToolCallDelta[]) => void
  /** The relay request id the response header carries, reported once. */
  onRequestId: (requestId: string) => void
  /** The usage frame the relay appended at the end of the stream. */
  onUsage: (usage: MessageUsage) => void
  /**
   * Provider finish reason of the last data frame, when the upstream reported
   * one. It labels the stored version (for example `length` enables the
   * "continue generation" action).
   */
  onFinishReason?: (finishReason: string) => void
  /**
   * The raw transcript as it arrived (bounded), reported when the stream ends
   * or fails so the request viewer can show exactly what the relay sent.
   */
  onRawResponse?: (raw: string) => void
  onComplete: () => void
  onError: (error: string, errorCode?: string) => void
}

interface StreamRequestControllerRuntime {
  getHeaders: () => Promise<Record<string, string>>
  createSource: (
    payload: ChatCompletionRequest,
    headers: Record<string, string>
  ) => StreamEventSource
  setStreaming: (streaming: boolean) => void
}

interface ProtocolFetchRuntime {
  abort: () => void
}

const TRUNCATED_TRANSCRIPT_MARKER = '\n… [response truncated for display]'

function appendTranscript(current: string, chunk: string): string {
  if (current.length >= PLAYGROUND_CAPTURED_RESPONSE_MAX_CHARS) return current
  const next = current + chunk
  if (next.length <= PLAYGROUND_CAPTURED_RESPONSE_MAX_CHARS) return next
  return (
    next.slice(0, PLAYGROUND_CAPTURED_RESPONSE_MAX_CHARS) +
    TRUNCATED_TRANSCRIPT_MARKER
  )
}

function parseProtocolErrorBody(body: string): {
  errorCode?: string
  errorMessage: string
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string; message?: string }
      message?: string
    }
    return {
      errorCode: parsed.error?.code || parsed.error?.type || undefined,
      errorMessage:
        parsed.error?.message ||
        parsed.message ||
        ERROR_MESSAGES.API_REQUEST_ERROR,
    }
  } catch {
    return {
      errorMessage: body.trim() || ERROR_MESSAGES.API_REQUEST_ERROR,
    }
  }
}

export function createStreamRequestController(
  runtime: StreamRequestControllerRuntime
) {
  let source: StreamEventSource | null = null
  let protocolSource: ProtocolFetchRuntime | null = null
  let generation = 0

  const closeActiveSource = (target: StreamEventSource) => {
    target.close()
    if (source === target) {
      source = null
      runtime.setStreaming(false)
    }
  }

  const send = async (
    payload: ChatCompletionRequest,
    callbacks: StreamRequestCallbacks
  ) => {
    const requestGeneration = generation + 1
    generation = requestGeneration
    const previousSource = source
    source = null
    previousSource?.close()
    protocolSource?.abort()
    protocolSource = null
    runtime.setStreaming(false)

    let headers: Record<string, string>
    try {
      headers = await runtime.getHeaders()
    } catch (error: unknown) {
      if (generation !== requestGeneration) return
      callbacks.onError(
        error instanceof Error
          ? error.message
          : ERROR_MESSAGES.STREAM_START_ERROR
      )
      return
    }
    if (generation !== requestGeneration) return

    const nextSource = runtime.createSource(payload, headers)
    source = nextSource
    runtime.setStreaming(true)
    let completed = false
    let requestIdReported = false
    let rawTranscript = ''

    const isCurrent = () =>
      generation === requestGeneration && source === nextSource

    // The relay echoes the request id it recorded, so the finished message can
    // be linked to its consume log. It is reported once, as soon as the
    // response headers are available.
    const captureRequestId = () => {
      if (requestIdReported || !isCurrent()) return
      const requestId = getStreamResponseRequestId(nextSource)
      if (!requestId) return
      requestIdReported = true
      callbacks.onRequestId(requestId)
    }

    const handleError = (errorMessage: string, errorCode?: string) => {
      if (!isCurrent() || completed) return
      completed = true
      callbacks.onRawResponse?.(rawTranscript)
      callbacks.onError(errorMessage, errorCode)
      closeActiveSource(nextSource)
    }

    nextSource.addEventListener('message', (event) => {
      if (!isCurrent() || completed) return
      const data = event.data ?? ''
      rawTranscript = appendTranscript(rawTranscript, `data: ${data}\n\n`)
      if (isStreamDoneMessage(data)) {
        completed = true
        captureRequestId()
        closeActiveSource(nextSource)
        callbacks.onRawResponse?.(rawTranscript)
        callbacks.onComplete()
        return
      }

      try {
        const { updates, toolCalls, usage, finishReason } =
          parseStreamChunk(data)

        for (const update of updates) {
          callbacks.onUpdate(update.type, update.chunk)
        }

        if (toolCalls.length > 0) {
          callbacks.onToolCalls(toolCalls)
        }

        if (usage) {
          callbacks.onUsage(usage)
        }

        if (finishReason) {
          callbacks.onFinishReason?.(finishReason)
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to parse SSE message:', error)
        handleError(ERROR_MESSAGES.PARSE_ERROR)
      }
    })

    nextSource.addEventListener('error', (event) => {
      if (!isCurrent() || completed) return
      if (!isStreamClosedReadyState(nextSource.readyState)) {
        // eslint-disable-next-line no-console
        console.error('SSE Error:', event)
        const { errorCode, errorMessage } = parseStreamErrorDetails(event.data)
        handleError(errorMessage, errorCode)
      }
    })

    nextSource.addEventListener('readystatechange', (event) => {
      if (!isCurrent() || completed) return
      captureRequestId()
      const errorMessage = getStreamReadyStateError(
        event.readyState,
        nextSource
      )

      if (errorMessage) {
        handleError(errorMessage)
      }
    })

    try {
      if (!isCurrent()) return
      nextSource.stream()
    } catch (error: unknown) {
      if (!isCurrent() || completed) return
      // eslint-disable-next-line no-console
      console.error('Failed to start SSE stream:', error)
      handleError(ERROR_MESSAGES.STREAM_START_ERROR)
    }
  }

  // The non-chat protocols stream through fetch instead of sse.js: their
  // events carry a named type, and the raw transcript is reconstructed from the
  // same frames the parser consumes.
  const sendProtocol = async (
    request: PlaygroundProtocolRequest,
    callbacks: StreamRequestCallbacks
  ) => {
    const requestGeneration = generation + 1
    generation = requestGeneration
    const previousSource = source
    source = null
    previousSource?.close()
    protocolSource?.abort()
    protocolSource = null
    runtime.setStreaming(false)

    let headers: Record<string, string>
    try {
      headers = await runtime.getHeaders()
    } catch (error: unknown) {
      if (generation !== requestGeneration) return
      callbacks.onError(
        error instanceof Error
          ? error.message
          : ERROR_MESSAGES.STREAM_START_ERROR
      )
      return
    }
    if (generation !== requestGeneration) return

    const abortController = new AbortController()
    const fetchRuntime: ProtocolFetchRuntime = {
      abort: () => abortController.abort(),
    }
    protocolSource = fetchRuntime
    runtime.setStreaming(true)
    let completed = false
    let requestIdReported = false
    let rawTranscript = ''

    const isCurrent = () =>
      generation === requestGeneration && protocolSource === fetchRuntime

    const finish = () => {
      if (!isCurrent() || completed) return
      completed = true
      runtime.setStreaming(false)
      callbacks.onRawResponse?.(rawTranscript)
      callbacks.onComplete()
    }

    const fail = (errorMessage: string, errorCode?: string) => {
      if (!isCurrent() || completed) return
      completed = true
      runtime.setStreaming(false)
      callbacks.onRawResponse?.(rawTranscript)
      callbacks.onError(errorMessage, errorCode)
    }

    const parser = createPlaygroundProtocolStreamParser(request.protocol)

    const handleFrame = (frame: string) => {
      if (!isCurrent() || completed) return
      let eventName = ''
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line === '' || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (dataLines.length === 0) return
      const data = dataLines.join('\n')
      rawTranscript = appendTranscript(
        rawTranscript,
        `${eventName ? `event: ${eventName}\n` : ''}data: ${data}\n\n`
      )
      if (isStreamDoneMessage(data)) {
        finish()
        return
      }

      const outcome = parser(eventName, data)
      if (!outcome) return
      for (const update of outcome.updates) {
        callbacks.onUpdate(update.type, update.chunk)
      }
      if (outcome.toolCalls.length > 0) {
        callbacks.onToolCalls(outcome.toolCalls)
      }
      if (outcome.usage) {
        callbacks.onUsage(outcome.usage)
      }
      if (outcome.finishReason) {
        callbacks.onFinishReason?.(outcome.finishReason)
      }
      if (outcome.error) {
        fail(outcome.error.errorMessage, outcome.error.errorCode)
        return
      }
      if (outcome.done) finish()
    }

    try {
      const response = await fetch(request.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(request.protocol === 'messages'
            ? { 'anthropic-version': PLAYGROUND_ANTHROPIC_VERSION }
            : {}),
        },
        body: JSON.stringify(request.body),
        signal: abortController.signal,
      })
      if (!isCurrent()) return

      const requestId = response.headers.get(PLAYGROUND_REQUEST_ID_HEADER)
      if (requestId && !requestIdReported) {
        requestIdReported = true
        callbacks.onRequestId(requestId)
      }

      if (!response.ok) {
        const details = parseProtocolErrorBody(await response.text())
        fail(details.errorMessage, details.errorCode)
        return
      }
      if (!response.body) {
        fail(ERROR_MESSAGES.STREAM_START_ERROR)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (isCurrent() && !completed) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let separator = buffer.indexOf('\n\n')
        while (separator >= 0) {
          const frame = buffer.slice(0, separator).replace(/\r\n/g, '\n')
          buffer = buffer.slice(separator + 2)
          handleFrame(frame)
          separator = buffer.indexOf('\n\n')
        }
      }
      if (isCurrent() && !completed && buffer.trim() !== '') {
        handleFrame(buffer.replace(/\r\n/g, '\n'))
      }
      if (isCurrent() && !completed) finish()
    } catch (error: unknown) {
      if (!isCurrent() || completed) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      // eslint-disable-next-line no-console
      console.error('Failed to read protocol stream:', error)
      fail(ERROR_MESSAGES.STREAM_START_ERROR)
    }
  }

  const cancel = (notify: boolean) => {
    generation += 1
    const activeSource = source
    source = null
    activeSource?.close()
    protocolSource?.abort()
    protocolSource = null
    if (notify) runtime.setStreaming(false)
  }

  const stop = () => cancel(true)
  const dispose = () => cancel(false)

  return { send, sendProtocol, stop, dispose }
}

/**
 * Hook for handling streaming chat completion requests
 */
export function useStreamRequest() {
  const [isStreaming, setIsStreaming] = useState(false)
  const controllerRef = useRef<ReturnType<
    typeof createStreamRequestController
  > | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createStreamRequestController({
      getHeaders: getFreshAuthHeaders,
      createSource: (payload, headers) =>
        new SSE(API_ENDPOINTS.CHAT_COMPLETIONS, {
          headers,
          method: 'POST',
          payload: JSON.stringify(payload),
        }) as StreamEventSource,
      setStreaming: setIsStreaming,
    })
  }

  const sendStreamRequest = useCallback(
    (payload: ChatCompletionRequest, callbacks: StreamRequestCallbacks) =>
      controllerRef.current?.send(payload, callbacks),
    []
  )

  const sendProtocolStreamRequest = useCallback(
    (request: PlaygroundProtocolRequest, callbacks: StreamRequestCallbacks) =>
      controllerRef.current?.sendProtocol(request, callbacks),
    []
  )

  const stopStream = useCallback(() => {
    controllerRef.current?.stop()
  }, [])

  useEffect(
    () => () => {
      controllerRef.current?.dispose()
    },
    []
  )

  return {
    sendStreamRequest,
    sendProtocolStreamRequest,
    stopStream,
    isStreaming,
  }
}
