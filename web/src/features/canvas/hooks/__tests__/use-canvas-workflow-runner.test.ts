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
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { clearPlaygroundAttachmentCache } from '@/features/playground/lib/attachment-store'
import { api } from '@/lib/api'

import { CANVAS_WORKFLOW_MESSAGES } from '../../constants'
import { CANVAS_WORKFLOW_ERRORS } from '../../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeWorkflowState,
} from '../../types'
import type { CanvasNodeDataUpdate } from '../use-canvas-editor'
import { useCanvasWorkflowRunner } from '../use-canvas-workflow-runner'

beforeEach(() => {
  clearPlaygroundAttachmentCache()
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:test',
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => undefined,
    })
  }
})

afterEach(() => {
  cleanup()
  clearPlaygroundAttachmentCache()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function graphNode(
  id: string,
  kind: CanvasNodeData['kind'],
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, ...data } }
}

function imageChain(): {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
} {
  return {
    nodes: [
      graphNode('p1', 'prompt', { text: 'a red fox' }),
      graphNode('m1', 'model', { workflow: { model: 'gpt-4o' } }),
      graphNode('t1', 'task', {
        workflow: { model: 'gpt-image-1', generation: 'image' },
      }),
      graphNode('r1', 'task-result'),
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'm1' },
      { id: 'e2', source: 'm1', target: 't1' },
      { id: 'e3', source: 't1', target: 'r1' },
    ],
  }
}

function videoChain(workflow: CanvasNodeWorkflowState): {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
} {
  return {
    nodes: [
      graphNode('p1', 'prompt', { text: 'a sailing ship' }),
      graphNode('t1', 'task', {
        workflow: { model: 'kling-v1', generation: 'video', ...workflow },
      }),
      graphNode('r1', 'task-result'),
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 't1' },
      { id: 'e2', source: 't1', target: 'r1' },
    ],
  }
}

function taskRowReply(taskId: string, status: string, failReason?: string) {
  return {
    data: {
      success: true,
      data: {
        items: [
          {
            task_id: taskId,
            status,
            ...(failReason ? { fail_reason: failReason } : {}),
          },
        ],
        total: 1,
      },
    },
  }
}

function artifactReply(taskId: string, key: string) {
  return {
    data: {
      success: true,
      data: {
        artifacts: [
          {
            key,
            type: 'video',
            content_url: `https://gateway.example.com/v1/tasks/${taskId}/artifacts/${key}/content?access=${'a'.repeat(43)}`,
          },
        ],
      },
    },
  }
}

/**
 * Drains the promise chain a run builds while fake timers are active:
 * submission, the first durable-row read and the scheduled poll delay.
 */
async function flushWorkflowMicrotasks() {
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

/**
 * Mirrors the editor contract the runner relies on: node data updates are
 * applied functionally to the latest state, a linked node joins the graph
 * immediately, and the hook receives both results.
 */
function useRunnerHarness(
  initialNodes: CanvasFlowNode[],
  initialEdges: CanvasFlowEdge[],
  group = 'default',
  nodeLimit = Number.POSITIVE_INFINITY
) {
  const [nodes, setNodes] = useState(initialNodes)
  const [edges, setEdges] = useState(initialEdges)
  const nodesRef = useRef(initialNodes)
  const edgesRef = useRef(initialEdges)
  const updateNodeData = useCallback(
    (id: string, update: CanvasNodeDataUpdate) => {
      const next = nodesRef.current.map((node) => {
        if (node.id !== id) return node
        const patch = typeof update === 'function' ? update(node.data) : update
        return { ...node, data: { ...node.data, ...patch } }
      })
      nodesRef.current = next
      setNodes(next)
    },
    []
  )
  const addLinkedNode = useCallback(
    (
      kind: CanvasNodeData['kind'],
      sourceId: string,
      data: Partial<CanvasNodeData>
    ): string | null => {
      if (nodesRef.current.length >= nodeLimit) return null
      const id = `auto-${nodesRef.current.length + 1}`
      const source = nodesRef.current.find((node) => node.id === sourceId)
      const nextNodes = [
        ...nodesRef.current,
        {
          id,
          type: kind,
          position: { x: (source?.position.x ?? 0) + 340, y: 0 },
          data: { kind, ...data },
        },
      ]
      const nextEdges = [
        ...edgesRef.current,
        { id: `edge-${id}`, source: sourceId, target: id },
      ]
      nodesRef.current = nextNodes
      edgesRef.current = nextEdges
      setNodes(nextNodes)
      setEdges(nextEdges)
      return id
    },
    [nodeLimit]
  )
  const runner = useCanvasWorkflowRunner({
    nodes,
    edges,
    group,
    updateNodeData,
    addLinkedNode,
  })
  return { nodes, runner }
}

test('runs a model step into an image step and keeps the preview in memory', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/chat/completions') {
      return {
        data: {
          choices: [{ message: { role: 'assistant', content: 'fox prompt' } }],
        },
      }
    }
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const chain = imageChain()
  const hook = renderHook(() => useRunnerHarness(chain.nodes, chain.edges))

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(post).toHaveBeenCalledWith(
    '/pg/chat/completions',
    expect.objectContaining({
      model: 'gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'a red fox' }],
    }),
    expect.anything()
  )
  expect(post).toHaveBeenCalledWith(
    '/pg/images/generations',
    expect.objectContaining({
      model: 'gpt-image-1',
      prompt: 'fox prompt',
      group: 'default',
    }),
    expect.anything()
  )
  const model = hook.result.current.nodes.find((node) => node.id === 'm1')
  expect(model?.data.workflow).toMatchObject({
    status: 'succeeded',
    output: 'fox prompt',
  })
  const task = hook.result.current.nodes.find((node) => node.id === 't1')
  expect(task?.data.workflow).toMatchObject({
    status: 'succeeded',
    resultImageCount: 1,
  })
  expect(task?.data.workflow?.inputText).toBe('fox prompt')
  expect(hook.result.current.runner.results.t1).toEqual([
    'https://cdn.example.com/fox.png',
  ])
})

test('a failed step stops the run until it is retried from that step', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/chat/completions') throw new Error('upstream exploded')
    throw new Error(`Unexpected POST ${url}`)
  })
  const chain = imageChain()
  const hook = renderHook(() => useRunnerHarness(chain.nodes, chain.edges))

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  const model = hook.result.current.nodes.find((node) => node.id === 'm1')
  expect(model?.data.workflow).toMatchObject({
    status: 'failed',
    error: 'upstream exploded',
  })
  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
      ?.status
  ).toBeUndefined()
  expect(post).toHaveBeenCalledTimes(1)

  post.mockImplementation(async (url) => {
    if (url === '/pg/chat/completions') {
      return {
        data: {
          choices: [{ message: { role: 'assistant', content: 'fox prompt' } }],
        },
      }
    }
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  act(() => hook.result.current.runner.retry('m1'))
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(post).toHaveBeenCalledTimes(3)
  const retriedModel = hook.result.current.nodes.find(
    (node) => node.id === 'm1'
  )
  expect(retriedModel?.data.workflow).toMatchObject({
    status: 'succeeded',
    output: 'fox prompt',
  })
  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
  ).toMatchObject({ status: 'succeeded', resultImageCount: 1 })
})

test('a video step waits for the durable row and fills the task result node', async () => {
  vi.useFakeTimers()
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/videos') return { data: { task_id: 'task-1' } }
    throw new Error(`Unexpected POST ${url}`)
  })
  let taskReads = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/task/self')) {
      taskReads += 1
      return taskRowReply('task-1', taskReads === 1 ? 'IN_PROGRESS' : 'SUCCESS')
    }
    if (url === '/api/task/task-1/artifacts') {
      return artifactReply('task-1', 'out-1')
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const chain = videoChain({})
  const hook = renderHook(() => useRunnerHarness(chain.nodes, chain.edges))

  act(() => hook.result.current.runner.run())
  await flushWorkflowMicrotasks()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
  })

  expect(post).toHaveBeenCalledWith(
    '/pg/videos',
    expect.objectContaining({
      model: 'kling-v1',
      prompt: 'a sailing ship',
      group: 'default',
    }),
    expect.anything()
  )
  const task = hook.result.current.nodes.find((node) => node.id === 't1')
  expect(task?.data.workflow).toMatchObject({
    status: 'succeeded',
    taskId: 'task-1',
  })
  const result = hook.result.current.nodes.find((node) => node.id === 'r1')
  expect(result?.data.label).toBe('kling-v1 · video')
  expect(result?.data.ref).toEqual({
    taskId: 'task-1',
    taskArtifactKey: 'out-1',
  })
})

test('canceling a running video task aborts the wait and cancels the task', async () => {
  vi.useFakeTimers()
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/videos') return { data: { task_id: 'task-9' } }
    if (url === '/api/playground/tasks/task-9/cancel') {
      return { data: { success: true, data: {} } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/task/self')) {
      return taskRowReply('task-9', 'IN_PROGRESS')
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const chain = videoChain({})
  const hook = renderHook(() => useRunnerHarness(chain.nodes, chain.edges))

  act(() => hook.result.current.runner.run())
  await flushWorkflowMicrotasks()
  const pending = hook.result.current.nodes.find((node) => node.id === 't1')
  expect(pending?.data.workflow?.taskId).toBe('task-9')
  await act(async () => {
    await hook.result.current.runner.cancel()
  })

  expect(post).toHaveBeenCalledWith(
    '/api/playground/tasks/task-9/cancel',
    {},
    expect.anything()
  )
  const task = hook.result.current.nodes.find((node) => node.id === 't1')
  expect(task?.data.workflow).toMatchObject({
    status: 'canceled',
    taskId: 'task-9',
  })
  expect(hook.result.current.runner.phase).toBe('idle')
})

test('a step without any input is refused before anything is called', () => {
  const post = vi.spyOn(api, 'post').mockImplementation(() => {
    throw new Error('Unexpected POST')
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [graphNode('m1', 'model', { workflow: { model: 'gpt-4o' } })],
      []
    )
  )

  act(() => hook.result.current.runner.run())

  expect(hook.result.current.runner.message).toBe(
    CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED
  )
  expect(hook.result.current.runner.phase).toBe('idle')
  expect(post).not.toHaveBeenCalled()
})

test('a task left running on load settles from its durable row', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/task/self')) {
      return taskRowReply('task-7', 'SUCCESS')
    }
    if (url === '/api/task/task-7/artifacts') {
      return artifactReply('task-7', 'out-7')
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const chain = videoChain({ status: 'running', taskId: 'task-7' })
  const hook = renderHook(() => useRunnerHarness(chain.nodes, chain.edges))

  await waitFor(() =>
    expect(
      hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
        ?.status
    ).toBe('succeeded')
  )

  const result = hook.result.current.nodes.find((node) => node.id === 'r1')
  expect(result?.data.ref).toEqual({
    taskId: 'task-7',
    taskArtifactKey: 'out-7',
  })
})

test('links a result node to a step that had none', async () => {
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const chain = imageChain()
  const hook = renderHook(() =>
    useRunnerHarness(
      chain.nodes.filter((node) => node.id !== 'r1'),
      chain.edges.filter((edge) => edge.target !== 'r1')
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  const created = hook.result.current.nodes.find(
    (node) => node.data.kind === 'task-result'
  )
  expect(created).toBeDefined()
  expect(created?.data.label).toBe('gpt-image-1 · Image')
  expect(created?.data.workflow).toMatchObject({
    status: 'succeeded',
    model: 'gpt-image-1',
    generation: 'image',
    inputText: 'fox prompt',
    sourceNodeId: 't1',
  })
  expect(created?.data.ref).toBeUndefined()
  expect(hook.result.current.edges).toContainEqual(
    expect.objectContaining({ source: 't1', target: created?.id })
  )
})

test('sends the configured generation parameters in the step group', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('p1', 'prompt', { text: 'a red fox' }),
        graphNode('t1', 'task', {
          workflow: {
            model: 'gpt-image-1',
            generation: 'image',
            size: '1792x1024',
            quality: 'high',
            imageCount: 3,
            group: 'vip',
          },
        }),
      ],
      [{ id: 'e1', source: 'p1', target: 't1' }],
      'default'
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(post).toHaveBeenCalledWith(
    '/pg/images/generations',
    expect.objectContaining({
      model: 'gpt-image-1',
      prompt: 'a red fox',
      group: 'vip',
      size: '1792x1024',
      quality: 'high',
      n: 3,
    }),
    expect.anything()
  )
  const created = hook.result.current.nodes.find(
    (node) => node.data.kind === 'task-result'
  )
  expect(created?.data.workflow).toMatchObject({
    group: 'vip',
    size: '1792x1024',
    quality: 'high',
    imageCount: 3,
    inputText: 'a red fox',
  })
})

test('retries a result node through the step that produced it', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    if (url === '/pg/chat/completions') {
      return {
        data: {
          choices: [{ message: { role: 'assistant', content: 'fox prompt' } }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const chain = imageChain()
  const hook = renderHook(() => useRunnerHarness(chain.nodes, chain.edges))

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))
  expect(post).toHaveBeenCalledTimes(2)

  act(() => hook.result.current.runner.retry('r1'))
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(post).toHaveBeenCalledTimes(3)
  expect(post).toHaveBeenLastCalledWith(
    '/pg/images/generations',
    expect.objectContaining({ model: 'gpt-image-1', prompt: 'fox prompt' }),
    expect.anything()
  )
})

test('refuses to retry a result whose step left the board', () => {
  const post = vi.spyOn(api, 'post').mockImplementation(() => {
    throw new Error('Unexpected POST')
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('r1', 'task-result', {
          workflow: { sourceNodeId: 'gone', model: 'kling-v1' },
        }),
      ],
      []
    )
  )

  act(() => hook.result.current.runner.retry('r1'))

  expect(hook.result.current.runner.message).toBe(
    CANVAS_WORKFLOW_MESSAGES.RETRY_SOURCE_MISSING
  )
  expect(hook.result.current.runner.phase).toBe('idle')
  expect(post).not.toHaveBeenCalled()
})

test('reports a full canvas without failing the generation', async () => {
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('p1', 'prompt', { text: 'a red fox' }),
        graphNode('t1', 'task', {
          workflow: { model: 'gpt-image-1', generation: 'image' },
        }),
      ],
      [{ id: 'e1', source: 'p1', target: 't1' }],
      'default',
      2
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
      ?.status
  ).toBe('succeeded')
  expect(hook.result.current.runner.message).toBe(
    CANVAS_WORKFLOW_MESSAGES.RESULT_NODE_LIMIT
  )
  expect(
    hook.result.current.nodes.some((node) => node.data.kind === 'task-result')
  ).toBe(false)
})

test('reads a connected attachment as a reference image input', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/images/generations') {
      return {
        data: {
          created: 1,
          data: [{ url: 'https://cdn.example.com/fox.png' }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/playground/sessions/pgs_1/attachments/att_1/content') {
      return {
        data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('a1', 'attachment', {
          ref: { sessionId: 'pgs_1', attachmentId: 'att_1' },
        }),
        graphNode('t1', 'task', {
          text: 'paint the photo',
          workflow: { model: 'gpt-image-1', generation: 'image' },
        }),
      ],
      [{ id: 'e1', source: 'a1', target: 't1' }]
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  const body = post.mock.calls[0][1] as { images?: string[] }
  expect(body.images).toHaveLength(1)
  expect(body.images?.[0]).toMatch(/^data:image\/png;base64,/)
  const task = hook.result.current.nodes.find((node) => node.id === 't1')
  expect(task?.data.workflow?.inputImageCount).toBe(1)
})

test('sends a reference image to a model step as content parts', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/chat/completions') {
      return {
        data: {
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/playground/sessions/pgs_1/attachments/att_1/content') {
      return {
        data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('a1', 'attachment', {
          ref: { sessionId: 'pgs_1', attachmentId: 'att_1' },
        }),
        graphNode('m1', 'model', {
          text: 'describe this photo',
          workflow: { model: 'gpt-4o' },
        }),
      ],
      [{ id: 'e1', source: 'a1', target: 'm1' }]
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(post).toHaveBeenCalledWith(
    '/pg/chat/completions',
    expect.objectContaining({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this photo' },
            {
              type: 'image_url',
              image_url: {
                url: expect.stringMatching(/^data:image\/png;base64,/),
              },
            },
          ],
        },
      ],
    }),
    expect.anything()
  )
})

test('reports an unreadable reference image without calling the relay', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(() => {
    throw new Error('Unexpected POST')
  })
  vi.spyOn(api, 'get').mockImplementation(async () => {
    throw new Error('attachment is gone')
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('a1', 'attachment', {
          ref: { sessionId: 'pgs_1', attachmentId: 'att_1' },
        }),
        graphNode('t1', 'task', {
          text: 'paint the photo',
          workflow: { model: 'gpt-image-1', generation: 'image' },
        }),
      ],
      [{ id: 'e1', source: 'a1', target: 't1' }]
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(post).not.toHaveBeenCalled()
  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
  ).toMatchObject({
    status: 'failed',
    error: CANVAS_WORKFLOW_MESSAGES.IMAGE_UNAVAILABLE,
  })
})

test('stops the run when the relay refuses the task budget', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/pg/videos') {
      throw {
        response: {
          status: 429,
          data: {
            error: {
              code: 'PLAYGROUND_TASK_LIMIT_EXCEEDED',
              message:
                'Playground task concurrency limit reached. Wait for a running task to finish.',
            },
          },
        },
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const hook = renderHook(() =>
    useRunnerHarness(
      [
        graphNode('t1', 'task', {
          text: 'a sailing ship',
          workflow: { model: 'kling-v1', generation: 'video' },
        }),
        graphNode('t2', 'task', {
          text: 'another ship',
          workflow: { model: 'kling-v1', generation: 'video' },
        }),
      ],
      [{ id: 'e1', source: 't1', target: 't2' }]
    )
  )

  act(() => hook.result.current.runner.run())
  await waitFor(() => expect(hook.result.current.runner.phase).toBe('idle'))

  expect(
    hook.result.current.nodes.find((node) => node.id === 't1')?.data.workflow
  ).toMatchObject({
    status: 'failed',
    error:
      'Playground task concurrency limit reached. Wait for a running task to finish.',
  })
  expect(
    hook.result.current.nodes.find((node) => node.id === 't2')?.data.workflow
      ?.status
  ).toBeUndefined()
  expect(post).toHaveBeenCalledTimes(1)
})
