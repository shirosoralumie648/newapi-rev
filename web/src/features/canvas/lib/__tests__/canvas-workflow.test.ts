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
import { expect, test } from 'vitest'

import {
  CANVAS_WORKFLOW_ERROR_MAX_CHARS,
  CANVAS_WORKFLOW_INPUT_MAX_CHARS,
  CANVAS_WORKFLOW_MENTION_MAX_MATCHES,
} from '../../constants'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeWorkflowState,
} from '../../types'
import {
  boundCanvasWorkflowError,
  CANVAS_WORKFLOW_ERRORS,
  canvasWorkflowGenerationSupport,
  canvasWorkflowGroup,
  canvasWorkflowIsPreferredResult,
  canvasWorkflowMentionMatches,
  canvasWorkflowMentionQuery,
  canvasWorkflowMentions,
  canvasWorkflowNodeText,
  canvasWorkflowOutputTargets,
  canvasWorkflowPreferredSibling,
  canvasWorkflowResultKind,
  canvasWorkflowRetryRecord,
  canvasWorkflowRetrySource,
  hasCanvasWorkflowInput,
  insertCanvasWorkflowMention,
  orderCanvasWorkflow,
  resolveCanvasWorkflowGeneration,
  resolveCanvasWorkflowImageSources,
  resolveCanvasWorkflowInput,
  validateCanvasWorkflow,
  wouldCreateCanvasWorkflowCycle,
} from '../canvas-workflow'

function flowNode(
  id: string,
  kind: CanvasNodeData['kind'],
  data: Partial<CanvasNodeData> = {}
): CanvasFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, ...data } }
}

function flowEdge(source: string, target: string): CanvasFlowEdge {
  return { id: `${source}-${target}`, source, target }
}

function modelNode(id: string, model?: string): CanvasFlowNode {
  return flowNode(id, 'model', {
    workflow: model === undefined ? {} : { model },
  })
}

test('orders the steps by dependency and refuses a cyclic graph', () => {
  const nodes = [
    flowNode('p1', 'prompt', { text: 'hello' }),
    modelNode('m1', 'gpt-4o'),
    modelNode('m2', 'gpt-4o-mini'),
    flowNode('r1', 'task-result'),
  ]
  const edges = [
    flowEdge('p1', 'm1'),
    flowEdge('m1', 'm2'),
    flowEdge('m2', 'r1'),
  ]

  expect(orderCanvasWorkflow(nodes, edges)).toEqual({ steps: ['m1', 'm2'] })
  expect(
    orderCanvasWorkflow(nodes, [flowEdge('m1', 'm2'), flowEdge('m2', 'm1')])
  ).toEqual({ error: CANVAS_WORKFLOW_ERRORS.CYCLE })
})

test('refuses a connection that closes a loop and allows a forward link', () => {
  const edges = [flowEdge('a', 'b'), flowEdge('b', 'c')]

  expect(wouldCreateCanvasWorkflowCycle(edges, 'c', 'a')).toBe(true)
  expect(wouldCreateCanvasWorkflowCycle(edges, 'c', 'd')).toBe(false)
  expect(wouldCreateCanvasWorkflowCycle(edges, 'a', 'a')).toBe(true)
})

test('validation reports missing steps, model and upstream input', () => {
  const prompt = flowNode('p1', 'prompt', { text: 'hello' })

  expect(validateCanvasWorkflow([prompt], [])).toBe(
    CANVAS_WORKFLOW_ERRORS.NO_STEPS
  )
  expect(
    validateCanvasWorkflow([prompt, modelNode('m1')], [flowEdge('p1', 'm1')])
  ).toBe(CANVAS_WORKFLOW_ERRORS.MODEL_REQUIRED)
  expect(validateCanvasWorkflow([prompt, modelNode('m1', 'gpt-4o')], [])).toBe(
    CANVAS_WORKFLOW_ERRORS.INPUT_REQUIRED
  )
  expect(
    validateCanvasWorkflow(
      [prompt, modelNode('m1', 'gpt-4o')],
      [flowEdge('p1', 'm1')]
    )
  ).toBeNull()
})

test('hasCanvasWorkflowInput accepts own text or a connection', () => {
  const bare = modelNode('m1', 'gpt-4o')

  expect(hasCanvasWorkflowInput(bare, [])).toBe(false)
  expect(
    hasCanvasWorkflowInput(flowNode('m2', 'model', { text: 'do it' }), [])
  ).toBe(true)
  expect(hasCanvasWorkflowInput(bare, [flowEdge('p1', 'm1')])).toBe(true)
})

test('resolves a step input from its own text and upstream outputs', () => {
  const prompt = flowNode('p1', 'prompt', { text: 'upstream' })
  const step = flowNode('m1', 'model', {
    text: 'own',
    workflow: { model: 'gpt-4o' },
  })
  const edges = [flowEdge('p1', 'm1')]
  const outputs = new Map<string, string>()

  expect(resolveCanvasWorkflowInput(step, [prompt, step], edges, outputs)).toBe(
    'own\n\nupstream'
  )

  outputs.set('p1', 'fresh')
  expect(resolveCanvasWorkflowInput(step, [prompt, step], edges, outputs)).toBe(
    'own\n\nfresh'
  )
})

test('falls back to the stored output of an upstream step and bounds the text', () => {
  const upstream = flowNode('m0', 'model', {
    workflow: { model: 'gpt-4o', output: 'stored output' },
  })
  const step = flowNode('m1', 'model', { workflow: { model: 'gpt-4o' } })

  expect(
    resolveCanvasWorkflowInput(
      step,
      [upstream, step],
      [flowEdge('m0', 'm1')],
      new Map()
    )
  ).toBe('stored output')

  const long = flowNode('p1', 'prompt', { text: 'x'.repeat(9000) })
  const resolved = resolveCanvasWorkflowInput(
    flowNode('m2', 'model', { workflow: { model: 'gpt-4o' } }),
    [long],
    [flowEdge('p1', 'm2')],
    new Map()
  )
  expect(resolved).toHaveLength(CANVAS_WORKFLOW_INPUT_MAX_CHARS)
})

test('canvasWorkflowNodeText prefers authored text over saved output', () => {
  expect(
    canvasWorkflowNodeText({
      kind: 'model',
      text: 'typed',
      workflow: { model: 'gpt-4o', output: 'previous' },
    })
  ).toBe('typed')
  expect(
    canvasWorkflowNodeText({
      kind: 'model',
      workflow: { model: 'gpt-4o', output: 'previous' },
    })
  ).toBe('previous')
})

test('collects only the downstream task-result nodes of a generation step', () => {
  const nodes = [
    flowNode('t1', 'task', { workflow: { model: 'gpt-image-1' } }),
    flowNode('r1', 'task-result'),
    flowNode('r2', 'task-result'),
    flowNode('n1', 'note', { text: 'notes' }),
  ]
  const edges = [
    flowEdge('t1', 'n1'),
    flowEdge('t1', 'r1'),
    flowEdge('t1', 'r2'),
    flowEdge('t1', 'r1'),
  ]

  expect(canvasWorkflowOutputTargets('t1', nodes, edges)).toEqual(['r1', 'r2'])
})

test('routes an artifact to the result node kind that can show it', () => {
  expect(canvasWorkflowResultKind('video')).toBe('video')
  expect(canvasWorkflowResultKind('audio')).toBe('audio')
  expect(canvasWorkflowResultKind('image')).toBe('task-result')
  expect(canvasWorkflowResultKind(undefined)).toBe('task-result')

  const nodes = [
    flowNode('t1', 'task', { workflow: { model: 'kling-v1' } }),
    flowNode('v1', 'video'),
    flowNode('a1', 'audio'),
    flowNode('r1', 'task-result'),
  ]
  const edges = [
    flowEdge('t1', 'v1'),
    flowEdge('t1', 'a1'),
    flowEdge('t1', 'r1'),
  ]

  expect(canvasWorkflowOutputTargets('t1', nodes, edges)).toEqual([
    'v1',
    'a1',
    'r1',
  ])
})

test('bounds a failure summary before it is stored on a node', () => {
  const bounded = boundCanvasWorkflowError('e'.repeat(2000))

  expect(bounded).toHaveLength(CANVAS_WORKFLOW_ERROR_MAX_CHARS)
  expect(boundCanvasWorkflowError('short')).toBe('short')
})

test('offers only directly connected nodes as mentions', () => {
  const prompt = flowNode('p1', 'prompt', { text: 'a red fox' })
  const attachment = flowNode('a1', 'attachment', {
    label: 'photo.png',
    ref: { sessionId: 'pgs_1', attachmentId: 'att_1' },
  })
  const pdf = flowNode('a3', 'attachment', {
    label: 'notes.pdf',
    mediaType: 'application/pdf',
    ref: { sessionId: 'pgs_1', attachmentId: 'att_3' },
  })
  const result = flowNode('r1', 'task-result', {
    label: 'clip',
    ref: { taskId: 'task-1', taskArtifactKey: 'out-1' },
  })
  const deleted = flowNode('a2', 'image', {
    label: 'gone.png',
    sourceDeleted: true,
    ref: { sessionId: 'pgs_1', attachmentId: 'att_2' },
  })
  const unrelated = flowNode('p2', 'prompt', { text: 'not connected' })
  const step = modelNode('m1', 'gpt-4o')
  const nodes = [prompt, attachment, pdf, result, deleted, unrelated, step]
  const edges = [
    flowEdge('p1', 'm1'),
    flowEdge('a1', 'm1'),
    flowEdge('a3', 'm1'),
    flowEdge('r1', 'm1'),
    flowEdge('a2', 'm1'),
    flowEdge('a2', 'm1'),
  ]

  const mentions = canvasWorkflowMentions(step, nodes, edges)
  expect(mentions.map((mention) => mention.nodeId)).toEqual([
    'p1',
    'a1',
    'a3',
    'r1',
    'a2',
  ])
  expect(mentions[0]).toMatchObject({
    label: 'Prompt',
    hasText: true,
    hasImage: false,
  })
  expect(mentions[1]).toMatchObject({
    label: 'photo.png',
    hasText: false,
    hasImage: true,
  })
  // A PDF attachment is a valid mention but not a source of image bytes.
  expect(mentions[2]).toMatchObject({ hasImage: false })
  expect(mentions[3]).toMatchObject({ hasImage: true })
  // A node the read path already flagged as deleted is not offered as input.
  expect(mentions[4]).toMatchObject({ hasImage: false })
})

test('resolves the mention query at the caret only', () => {
  expect(canvasWorkflowMentionQuery('hello @ph', 9)).toBe('ph')
  expect(canvasWorkflowMentionQuery('hello @', 7)).toBe('')
  expect(canvasWorkflowMentionQuery('hello @ph', 6)).toBeNull()
  expect(canvasWorkflowMentionQuery('mail@example', 12)).toBeNull()
  expect(canvasWorkflowMentionQuery('no mention', 10)).toBeNull()
})

test('inserts a mention token and replaces the typed query', () => {
  expect(
    insertCanvasWorkflowMention('hello @ph', 9, 'ph', 'photo.png')
  ).toEqual({ value: 'hello @photo.png ', caret: 17 })
  expect(insertCanvasWorkflowMention('hello ', 6, '', 'photo.png')).toEqual({
    value: 'hello @photo.png ',
    caret: 17,
  })
  expect(insertCanvasWorkflowMention('hello', 5, '', 'photo.png')).toEqual({
    value: 'hello@photo.png ',
    caret: 16,
  })
})

test('matches mention candidates case-insensitively and bounds the list', () => {
  const mentions = Array.from({ length: 12 }, (_, index) => ({
    nodeId: `n${index}`,
    label: `node ${index}`,
    kind: 'text' as const,
    hasText: true,
    hasImage: false,
  }))

  expect(
    canvasWorkflowMentionMatches(mentions, 'NODE 1').map((m) => m.nodeId)
  ).toEqual(['n1', 'n10', 'n11'])
  expect(canvasWorkflowMentionMatches(mentions, '')).toHaveLength(
    CANVAS_WORKFLOW_MENTION_MAX_MATCHES
  )
})

test('places a mentioned upstream text where the mention stands', () => {
  const prompt = flowNode('p1', 'prompt', { text: 'a red fox' })
  const second = flowNode('p2', 'prompt', { label: 'style', text: 'oil paint' })
  const attachment = flowNode('a1', 'attachment', {
    label: 'photo.png',
    ref: { sessionId: 'pgs_1', attachmentId: 'att_1' },
  })
  const step = flowNode('m1', 'model', {
    text: 'Paint @photo.png in the mood of @style',
    workflow: { model: 'gpt-4o' },
  })
  const nodes = [prompt, second, attachment, step]
  const edges = [
    flowEdge('p1', 'm1'),
    flowEdge('p2', 'm1'),
    flowEdge('a1', 'm1'),
  ]

  // The mentioned-style node is not appended a second time, the unmentioned
  // prompt still is, and a node without text is replaced by its label.
  expect(resolveCanvasWorkflowInput(step, nodes, edges, new Map())).toBe(
    'Paint photo.png in the mood of oil paint\n\na red fox'
  )

  const run = new Map([['p2', 'watercolour']])
  expect(resolveCanvasWorkflowInput(step, nodes, edges, run)).toBe(
    'Paint photo.png in the mood of watercolour\n\na red fox'
  )
})

test('leaves an unknown mention token untouched', () => {
  const step = flowNode('m1', 'model', {
    text: 'hello @nobody',
    workflow: { model: 'gpt-4o' },
  })

  expect(resolveCanvasWorkflowInput(step, [step], [], new Map())).toBe(
    'hello @nobody'
  )
})

test('collects reference images from connected resources', () => {
  const attachment = flowNode('a1', 'attachment', {
    ref: { sessionId: 'pgs_1', attachmentId: 'att_1' },
  })
  const image = flowNode('i1', 'image', {
    ref: { sessionId: 'pgs_1', attachmentId: 'att_2' },
  })
  const result = flowNode('r1', 'task-result', {
    ref: { taskId: 'task-1' },
  })
  const keyed = flowNode('r2', 'task-result', {
    ref: { taskId: 'task-2', taskArtifactKey: 'out-2' },
  })
  const deleted = flowNode('a2', 'attachment', {
    sourceDeleted: true,
    ref: { sessionId: 'pgs_1', attachmentId: 'att_3' },
  })
  const pdf = flowNode('a3', 'attachment', {
    mediaType: 'application/pdf',
    ref: { sessionId: 'pgs_1', attachmentId: 'att_4' },
  })
  const step = flowNode('t1', 'task', {
    workflow: { model: 'gpt-image-1', generation: 'image' },
  })
  const nodes = [attachment, image, result, keyed, deleted, pdf, step]
  const edges = [
    flowEdge('a1', 't1'),
    flowEdge('i1', 't1'),
    flowEdge('r1', 't1'),
    flowEdge('r2', 't1'),
    flowEdge('a2', 't1'),
    flowEdge('a3', 't1'),
    flowEdge('a1', 't1'),
  ]

  expect(resolveCanvasWorkflowImageSources(step, nodes, edges)).toEqual([
    {
      nodeId: 'a1',
      kind: 'attachment',
      sessionId: 'pgs_1',
      attachmentId: 'att_1',
    },
    {
      nodeId: 'i1',
      kind: 'attachment',
      sessionId: 'pgs_1',
      attachmentId: 'att_2',
    },
    { nodeId: 'r1', kind: 'task-result', taskId: 'task-1' },
    {
      nodeId: 'r2',
      kind: 'task-result',
      taskId: 'task-2',
      artifactKey: 'out-2',
    },
  ])
})

test('resolves a connected batch result to its preferred sibling', () => {
  const step = flowNode('t1', 'task', {
    workflow: { preferredResultNodeId: 'r2' },
  })
  const first = flowNode('r1', 'task-result', {
    workflow: { sourceNodeId: 't1', preferred: false },
    ref: { taskId: 'task-1', taskArtifactKey: 'out-1' },
  })
  const preferred = flowNode('r2', 'task-result', {
    workflow: { sourceNodeId: 't1', preferred: true },
    ref: { taskId: 'task-2', taskArtifactKey: 'out-2' },
  })
  const downstream = flowNode('t2', 'task', {
    workflow: { model: 'gpt-image-1' },
  })
  const nodes = [step, first, preferred, downstream]
  const edges = [flowEdge('r1', 't2'), flowEdge('r2', 't2')]

  expect(canvasWorkflowPreferredSibling(first, nodes)?.id).toBe('r2')
  expect(canvasWorkflowIsPreferredResult(first, nodes)).toBe(false)
  expect(canvasWorkflowIsPreferredResult(preferred, nodes)).toBe(true)
  expect(resolveCanvasWorkflowImageSources(downstream, nodes, edges)).toEqual([
    {
      nodeId: 'r2',
      kind: 'task-result',
      taskId: 'task-2',
      artifactKey: 'out-2',
    },
  ])
})

test('bounds the generation parameters of an imported step', () => {
  const step = (workflow: Partial<CanvasNodeWorkflowState>): CanvasFlowNode =>
    flowNode('t1', 'task', { workflow })
  const base = { model: 'gpt-image-1' }

  expect(
    resolveCanvasWorkflowGeneration(
      step({
        ...base,
        generation: 'image',
        size: '1792x1024',
        quality: 'high',
        imageCount: 3,
      })
    )
  ).toEqual({
    generation: 'image',
    size: '1792x1024',
    quality: 'high',
    imageCount: 3,
  })
  expect(
    resolveCanvasWorkflowGeneration(
      step({
        ...base,
        generation: 'image',
        size: '4096x4096',
        quality: 'ultra',
        imageCount: 99,
      })
    )
  ).toEqual({ generation: 'image', size: '4096x4096' })
  expect(
    resolveCanvasWorkflowGeneration(
      step({
        ...base,
        generation: 'image',
        size: '640x480',
        seed: 42,
      })
    )
  ).toEqual({ generation: 'image', size: '640x480', seed: 42 })
  expect(
    resolveCanvasWorkflowGeneration(
      step({
        ...base,
        generation: 'image',
        size: '9000x9000',
        seed: 0,
      })
    )
  ).toEqual({ generation: 'image' })
  expect(
    resolveCanvasWorkflowGeneration(
      step({
        ...base,
        generation: 'image',
        imageCount: 2.5,
      })
    )
  ).toEqual({ generation: 'image' })
  expect(
    resolveCanvasWorkflowGeneration(
      step({ ...base, generation: 'video', size: '720x1280', duration: 30 })
    )
  ).toEqual({ generation: 'video', size: '720x1280', duration: 30 })
  expect(
    resolveCanvasWorkflowGeneration(
      step({ ...base, generation: 'video', duration: 7200 })
    )
  ).toEqual({ generation: 'video' })
})

test('reads generation support from channel endpoint and task usage metadata', () => {
  expect(canvasWorkflowGenerationSupport(undefined)).toBeNull()
  expect(
    canvasWorkflowGenerationSupport({ endpointTypes: [], usageFields: [] })
  ).toBeNull()
  expect(
    canvasWorkflowGenerationSupport({
      endpointTypes: ['image-generation'],
      usageFields: [],
    })
  ).toEqual({ image: true, video: false })
  expect(
    canvasWorkflowGenerationSupport({
      endpointTypes: ['openai-video'],
      usageFields: [],
    })
  ).toEqual({ image: false, video: true })
  expect(
    canvasWorkflowGenerationSupport({
      endpointTypes: [],
      usageFields: ['image_count', 'seconds'],
    })
  ).toEqual({ image: true, video: true })
  expect(
    canvasWorkflowGenerationSupport({
      endpointTypes: ['openai'],
      usageFields: [],
    })
  ).toEqual({ image: false, video: false })
})

test('resolves the run group from the step override first', () => {
  expect(
    canvasWorkflowGroup(flowNode('m1', 'model', { workflow: {} }), 'default')
  ).toBe('default')
  expect(
    canvasWorkflowGroup(
      flowNode('m1', 'model', { workflow: { group: 'vip' } }),
      'default'
    )
  ).toBe('vip')
  expect(
    canvasWorkflowGroup(
      flowNode('m1', 'model', { workflow: { group: '  ' } }),
      'default'
    )
  ).toBe('default')
})

test('records the attempt on a result node for a one-click retry', () => {
  const step = flowNode('t1', 'task', {
    workflow: {
      model: 'kling-v1',
      generation: 'video',
      duration: 10,
      size: '1280x720',
      attempts: 2,
    },
  })

  const record = canvasWorkflowRetryRecord(step, {
    inputText: 'a sailing ship',
    group: 'default',
    inputImageCount: 1,
    seed: 12345,
  })
  expect(record).toMatchObject({
    status: 'succeeded',
    model: 'kling-v1',
    generation: 'video',
    duration: 10,
    size: '1280x720',
    seed: 12345,
    inputText: 'a sailing ship',
    group: 'default',
    inputImageCount: 1,
    sourceNodeId: 't1',
    attempts: 2,
  })

  const result = flowNode('r1', 'task-result', { workflow: record })
  expect(canvasWorkflowRetrySource(result)).toBe('t1')
  expect(
    canvasWorkflowRetrySource(flowNode('r2', 'task-result', { workflow: {} }))
  ).toBeNull()
})
