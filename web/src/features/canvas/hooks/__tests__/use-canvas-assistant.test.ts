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
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import {
  useStreamRequest,
  type StreamRequestCallbacks,
} from '@/features/playground/hooks/use-stream-request'
import type {
  ChatCompletionRequest,
  ModelOption,
} from '@/features/playground/types'

import {
  CANVAS_ASSISTANT_MESSAGES,
  CANVAS_LINKED_NODE_OFFSET_X,
  CANVAS_NODE_ADD_BASE,
  CANVAS_NODE_ADD_OFFSET,
} from '../../constants'
import { CANVAS_ERRORS } from '../../lib/canvas-document'
import type {
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
} from '../../types'
import { useCanvasAssistant } from '../use-canvas-assistant'

vi.mock('@/features/playground/hooks/use-stream-request', () => ({
  useStreamRequest: vi.fn(),
}))

const sendStreamRequest =
  vi.fn<
    (payload: ChatCompletionRequest, callbacks: StreamRequestCallbacks) => void
  >()
const stopStream = vi.fn<() => void>()

beforeEach(() => {
  sendStreamRequest.mockReset()
  stopStream.mockReset()
  vi.mocked(useStreamRequest).mockReturnValue({
    sendStreamRequest,
    stopStream,
    isStreaming: false,
  })
})

const MODELS: ModelOption[] = [
  { label: 'Model one', value: 'm1' },
  { label: 'Model two', value: 'm2' },
]

const ANCHOR_POSITION = { x: 120, y: 60 }

function node(
  id: string,
  kind: CanvasNodeKind,
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return {
    id,
    type: kind,
    position: { ...ANCHOR_POSITION },
    data: { kind, ...data },
  }
}

type Options = Parameters<typeof useCanvasAssistant>[0]

function assistantOptions(overrides: Partial<Options> = {}): Options {
  const anchor = node('a', 'text', { text: 'Anchor text' })
  return {
    nodes: [anchor],
    edges: [],
    anchorNode: anchor,
    group: 'default',
    models: MODELS,
    addLinkedNode: vi.fn(() => 'inserted'),
    addNodes: vi.fn(() => 1),
    runWorkflow: vi.fn(),
    ...overrides,
  }
}

test('streams a reply through the relay with the canvas context', () => {
  const hook = renderHook(() => useCanvasAssistant(assistantOptions()))

  act(() => hook.result.current.send('hello'))

  expect(sendStreamRequest).toHaveBeenCalledTimes(1)
  const [payload] = sendStreamRequest.mock.calls[0]
  expect(payload.model).toBe('m1')
  expect(payload.group).toBe('default')
  expect(payload.stream).toBe(true)
  expect(payload.messages[0]).toMatchObject({ role: 'system' })
  expect(payload.messages[0].content).toContain('Anchor text')
  expect(payload.messages.at(-1)).toEqual({ role: 'user', content: 'hello' })
  expect(hook.result.current.messages).toMatchObject([
    { role: 'user', content: 'hello', status: 'done' },
    { role: 'assistant', content: '', status: 'streaming' },
  ])

  const [, callbacks] = sendStreamRequest.mock.calls[0]
  act(() => callbacks.onUpdate('reasoning', 'thinking'))
  act(() => callbacks.onUpdate('content', 'Hi '))
  act(() => callbacks.onUpdate('content', 'there'))
  expect(hook.result.current.messages[1]).toMatchObject({
    content: 'Hi there',
    status: 'streaming',
  })

  act(() => callbacks.onComplete())
  expect(hook.result.current.messages[1].status).toBe('done')
})

test('replays recent history and ignores a second send while streaming', () => {
  const hook = renderHook(() => useCanvasAssistant(assistantOptions()))

  act(() => hook.result.current.send('first'))
  const [, callbacks] = sendStreamRequest.mock.calls[0]
  act(() => callbacks.onUpdate('content', 'answer'))
  act(() => callbacks.onComplete())

  act(() => hook.result.current.send('second'))
  expect(sendStreamRequest).toHaveBeenCalledTimes(2)
  const [second] = sendStreamRequest.mock.calls[1]
  expect(second.messages.slice(1)).toEqual([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ])

  act(() => hook.result.current.send('third'))
  expect(sendStreamRequest).toHaveBeenCalledTimes(2)
})

test('inherits the selected step model when the group offers it', () => {
  const anchor = node('a', 'model', { workflow: { model: 'm2' } })
  const hook = renderHook(() =>
    useCanvasAssistant(
      assistantOptions({ anchorNode: anchor, nodes: [anchor] })
    )
  )

  act(() => hook.result.current.send('hello'))

  const [payload] = sendStreamRequest.mock.calls[0]
  expect(payload.model).toBe('m2')
})

test('reports a missing model and ignores blank input', () => {
  const hook = renderHook(() =>
    useCanvasAssistant(assistantOptions({ models: [] }))
  )

  act(() => hook.result.current.send('   '))
  expect(sendStreamRequest).not.toHaveBeenCalled()

  act(() => hook.result.current.send('hello'))
  expect(hook.result.current.message).toBe(CANVAS_ASSISTANT_MESSAGES.NO_MODEL)
  expect(sendStreamRequest).not.toHaveBeenCalled()
})

test('marks a failed reply and settles a stopped stream', () => {
  const hook = renderHook(() => useCanvasAssistant(assistantOptions()))

  act(() => hook.result.current.send('hello'))
  const [, callbacks] = sendStreamRequest.mock.calls[0]
  act(() => callbacks.onUpdate('content', 'partial'))
  act(() => callbacks.onError('boom'))
  expect(hook.result.current.messages[1]).toMatchObject({
    status: 'error',
    error: 'boom',
  })

  act(() => hook.result.current.send('again'))
  act(() => hook.result.current.stop())

  expect(stopStream).toHaveBeenCalledTimes(1)
  expect(hook.result.current.messages[3]).toMatchObject({
    content: '',
    status: 'done',
  })
})

test('inserts a reply as a linked text node and stops when the canvas is full', () => {
  const addLinkedNode = vi.fn((): string | null => 'inserted')
  const hook = renderHook(() =>
    useCanvasAssistant(assistantOptions({ addLinkedNode }))
  )

  let inserted = false
  act(() => {
    inserted = hook.result.current.insertReply('  reply  ')
  })
  expect(inserted).toBe(true)
  expect(addLinkedNode).toHaveBeenCalledWith(
    'text',
    'a',
    { text: 'reply' },
    {
      x: ANCHOR_POSITION.x + CANVAS_LINKED_NODE_OFFSET_X,
      y: ANCHOR_POSITION.y,
    }
  )

  addLinkedNode.mockReturnValue(null)
  act(() => {
    inserted = hook.result.current.insertReply('reply')
  })
  expect(inserted).toBe(false)
  expect(hook.result.current.message).toBe(CANVAS_ERRORS.TOO_MANY_NODES)
})

test('drops a reply at the free cascade without a selection', () => {
  const addNodes = vi.fn(() => 1)
  const hook = renderHook(() =>
    useCanvasAssistant(assistantOptions({ anchorNode: null, addNodes }))
  )

  act(() => hook.result.current.insertReply('reply'))

  expect(addNodes).toHaveBeenCalledWith([
    {
      kind: 'text',
      position: {
        x: CANVAS_NODE_ADD_BASE + CANVAS_NODE_ADD_OFFSET,
        y: CANVAS_NODE_ADD_BASE + CANVAS_NODE_ADD_OFFSET,
      },
      data: { text: 'reply' },
    },
  ])
})

test('turns a reply into a generation step and runs it from that node', () => {
  const addLinkedNode = vi.fn(() => 'step')
  const runWorkflow = vi.fn()
  const hook = renderHook(() =>
    useCanvasAssistant(assistantOptions({ addLinkedNode, runWorkflow }))
  )

  act(() => hook.result.current.setMode('image'))
  act(() => hook.result.current.generate('draw a cat'))

  expect(addLinkedNode).toHaveBeenCalledWith(
    'task',
    'a',
    { text: 'draw a cat', workflow: { model: 'm1', generation: 'image' } },
    { x: ANCHOR_POSITION.x + CANVAS_LINKED_NODE_OFFSET_X, y: ANCHOR_POSITION.y }
  )
  expect(runWorkflow).toHaveBeenCalledWith('step')
})

test('requires a selected node before generating', () => {
  const addLinkedNode = vi.fn()
  const hook = renderHook(() =>
    useCanvasAssistant(assistantOptions({ anchorNode: null, addLinkedNode }))
  )

  expect(hook.result.current.canGenerate).toBe(false)
  act(() => hook.result.current.setMode('video'))

  let generated = true
  act(() => {
    generated = hook.result.current.generate('clip')
  })

  expect(generated).toBe(false)
  expect(addLinkedNode).not.toHaveBeenCalled()
  expect(hook.result.current.message).toBe(
    CANVAS_ASSISTANT_MESSAGES.ANCHOR_REQUIRED
  )
})

test('reports the context size and the anchor label', () => {
  const anchor = node('a', 'text', { label: 'Intro', text: 'Anchor text' })
  const upstream = node('b', 'prompt', { text: 'watercolor' })
  const hook = renderHook(() =>
    useCanvasAssistant(
      assistantOptions({
        anchorNode: anchor,
        edges: [{ id: 'b->a', source: 'b', target: 'a' }],
        nodes: [anchor, upstream],
      })
    )
  )

  expect(hook.result.current.contextCount).toBe(2)
  expect(hook.result.current.anchorLabel).toBe('Intro')
  expect(hook.result.current.canGenerate).toBe(true)
})
