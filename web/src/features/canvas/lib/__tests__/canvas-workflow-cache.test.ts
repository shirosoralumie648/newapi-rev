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

import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasWorkflowCacheEntry,
  CanvasWorkflowRun,
  CanvasWorkflowRunNodeRecord,
} from '../../types'
import { resolveCanvasWorkflowInput } from '../canvas-workflow'
import {
  CANVAS_WORKFLOW_CACHE_MAX_AGE_MS,
  CANVAS_WORKFLOW_RUN_DIFF_REASONS,
  canvasWorkflowCacheIndex,
  canvasWorkflowGraphVersion,
  canvasWorkflowPlanFingerprints,
  canvasWorkflowRunCacheEntries,
  canvasWorkflowStepFingerprint,
  diffCanvasWorkflowRuns,
} from '../canvas-workflow-cache'

function graphNode(
  id: string,
  kind: CanvasFlowNode['data']['kind'],
  data: Partial<CanvasFlowNode['data']> = {}
): CanvasFlowNode {
  return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, ...data } }
}

function workflowGraph() {
  const nodes: CanvasFlowNode[] = [
    graphNode('p1', 'prompt', { text: 'a red fox' }),
    graphNode('m1', 'model', {
      text: 'Describe it.',
      workflow: { model: 'gpt-4o' },
    }),
    graphNode('m2', 'model', { workflow: { model: 'gpt-4o-mini' } }),
    graphNode('t1', 'task', {
      workflow: {
        model: 'gpt-image-1',
        generation: 'image',
        size: '1024x1024',
        quality: 'high',
        imageCount: 2,
        seed: 42,
      },
    }),
    graphNode('r1', 'task-result'),
  ]
  const edges: CanvasFlowEdge[] = [
    { id: 'e1', source: 'p1', target: 'm1' },
    { id: 'e2', source: 'm1', target: 'm2' },
    { id: 'e3', source: 'm2', target: 't1' },
    { id: 'e4', source: 't1', target: 'r1' },
  ]
  return { nodes, edges }
}

function fingerprint(
  node: CanvasFlowNode,
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[],
  version: string,
  outputs = new Map<string, string>(),
  group = 'default'
): string {
  return canvasWorkflowStepFingerprint({
    node,
    nodes,
    edges,
    outputs,
    workflowVersion: version,
    input: resolveCanvasWorkflowInput(node, nodes, edges, outputs),
    group,
    seed: node.data.kind === 'task' ? node.data.workflow?.seed : undefined,
  })
}

function runNode(
  nodeId: string,
  overrides: Partial<CanvasWorkflowRunNodeRecord> = {}
): CanvasWorkflowRunNodeRecord {
  return {
    nodeId,
    kind: 'model',
    model: 'gpt-4o',
    group: 'default',
    status: 'succeeded',
    fingerprint: `wf1:${nodeId}`,
    cacheHit: false,
    output: 'output',
    taskId: '',
    artifactKeys: [],
    resultCount: 0,
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
    quota: 10,
    durationMs: 100,
    error: '',
    startedAt: 1000,
    finishedAt: 1100,
    ...overrides,
  }
}

function run(
  id: string,
  nodes: CanvasWorkflowRunNodeRecord[]
): CanvasWorkflowRun {
  return {
    id,
    canvasId: 'pgc_1',
    sessionId: '',
    workflowRevision: 1,
    status: 'completed',
    nodeCount: nodes.length,
    cacheHits: nodes.filter((node) => node.cacheHit).length,
    totalQuota: 10,
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
    durationMs: 100,
    estimateQuota: 20,
    budgetCap: 0,
    byteSize: 256,
    revision: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    nodes,
  }
}

test('result nodes do not change the workflow version', () => {
  const { nodes, edges } = workflowGraph()
  const version = canvasWorkflowGraphVersion(nodes, edges)
  const withResult = [...nodes, graphNode('r2', 'task-result')]
  expect(canvasWorkflowGraphVersion(withResult, edges)).toBe(version)
})

test('a changed prompt only invalidates that step and its descendants', () => {
  const { nodes, edges } = workflowGraph()
  const version = canvasWorkflowGraphVersion(nodes, edges)
  const m1 = nodes.find((node) => node.id === 'm1')!
  const m2 = nodes.find((node) => node.id === 'm2')!
  const beforeM1 = fingerprint(m1, nodes, edges, version)
  const beforeM2 = fingerprint(m2, nodes, edges, version)

  const changed = nodes.map((node) =>
    node.id === 'm2'
      ? { ...node, data: { ...node.data, text: 'another instruction' } }
      : node
  )
  const changedM2 = changed.find((node) => node.id === 'm2')!
  expect(fingerprint(m1, changed, edges, version)).toBe(beforeM1)
  expect(fingerprint(changedM2, changed, edges, version)).not.toBe(beforeM2)
})

test('upstream output, generation parameters, seed and group change the key', () => {
  const { nodes, edges } = workflowGraph()
  const version = canvasWorkflowGraphVersion(nodes, edges)
  const m2 = nodes.find((node) => node.id === 'm2')!
  const t1 = nodes.find((node) => node.id === 't1')!

  const firstOutput = new Map([['m1', 'first answer']])
  const secondOutput = new Map([['m1', 'second answer']])
  expect(fingerprint(m2, nodes, edges, version, firstOutput)).not.toBe(
    fingerprint(m2, nodes, edges, version, secondOutput)
  )

  const base = fingerprint(t1, nodes, edges, version, firstOutput)
  const differentSeed = fingerprint(
    {
      ...t1,
      data: {
        ...t1.data,
        workflow: { ...t1.data.workflow, seed: 43 },
      },
    },
    nodes,
    edges,
    version,
    firstOutput
  )
  const differentGroup = fingerprint(
    t1,
    nodes,
    edges,
    version,
    firstOutput,
    'vip'
  )
  expect(differentSeed).not.toBe(base)
  expect(differentGroup).not.toBe(base)
})

test('plan fingerprints are unique and cover every runnable step', () => {
  const { nodes, edges } = workflowGraph()
  const version = canvasWorkflowGraphVersion(nodes, edges)
  expect(
    canvasWorkflowPlanFingerprints(
      ['m1', 'm2', 't1', 'm1'],
      nodes,
      edges,
      version,
      'default'
    )
  ).toHaveLength(3)
})

test('the cache index skips forced, expired and incomplete entries', () => {
  const now = 1_700_000_000_000
  const entries: CanvasWorkflowCacheEntry[] = [
    {
      fingerprint: 'wf1:ok',
      nodeId: 'm1',
      kind: 'model',
      model: 'gpt-4o',
      output: 'answer',
      taskId: '',
      artifactKeys: [],
      resultCount: 0,
      quota: 10,
      runId: 'run_1',
      updatedAt: now - 1000,
    },
    {
      fingerprint: 'wf1:empty',
      nodeId: 'm2',
      kind: 'model',
      model: 'gpt-4o',
      output: '',
      taskId: '',
      artifactKeys: [],
      resultCount: 0,
      quota: 10,
      runId: 'run_1',
      updatedAt: now - 1000,
    },
    {
      fingerprint: 'wf1:task',
      nodeId: 't1',
      kind: 'task',
      model: 'gpt-image-1',
      output: '',
      taskId: '',
      artifactKeys: [],
      resultCount: 0,
      quota: 10,
      runId: 'run_1',
      updatedAt: now - 1000,
    },
    {
      fingerprint: 'wf1:old',
      nodeId: 'm3',
      kind: 'model',
      model: 'gpt-4o',
      output: 'old',
      taskId: '',
      artifactKeys: [],
      resultCount: 0,
      quota: 10,
      runId: 'run_1',
      updatedAt: now - CANVAS_WORKFLOW_CACHE_MAX_AGE_MS - 1,
    },
  ]

  expect([...canvasWorkflowCacheIndex(entries, { now }).keys()]).toEqual([
    'wf1:ok',
  ])
  expect(canvasWorkflowCacheIndex(entries, { now, force: true }).size).toBe(0)
})

test('a historical run becomes a reusable baseline without failed steps', () => {
  const entries = canvasWorkflowRunCacheEntries(
    run('run_1', [
      runNode('m1'),
      runNode('t1', {
        kind: 'task',
        taskId: 'task_1',
        artifactKeys: ['a1'],
        resultCount: 1,
      }),
      runNode('m2', { status: 'failed', output: '' }),
    ])
  )
  expect(entries.map((entry) => entry.fingerprint)).toEqual([
    'wf1:m1',
    'wf1:t1',
  ])
  expect(entries[1]).toMatchObject({
    taskId: 'task_1',
    artifactKeys: ['a1'],
    runId: 'run_1',
  })
})

test('a rerun diff reports every changed step and both one-sided rows', () => {
  const before = run('run_1', [
    runNode('m1', { output: 'old' }),
    runNode('t1', { kind: 'task', taskId: 'task_1', quota: 30 }),
  ])
  const after = run('run_2', [
    runNode('m1', { output: 'new', quota: 12, cacheHit: true }),
    runNode('m2', { output: 'added' }),
  ])
  const diff = diffCanvasWorkflowRuns(before, after)

  expect(diff.map((row) => row.nodeId)).toEqual(['m1', 't1', 'm2'])
  expect(diff[0].reasons).toEqual([
    CANVAS_WORKFLOW_RUN_DIFF_REASONS.COST,
    CANVAS_WORKFLOW_RUN_DIFF_REASONS.CACHE,
    CANVAS_WORKFLOW_RUN_DIFF_REASONS.OUTPUT,
  ])
  expect(diff[1].reasons).toEqual([CANVAS_WORKFLOW_RUN_DIFF_REASONS.REMOVED])
  expect(diff[2].reasons).toEqual([CANVAS_WORKFLOW_RUN_DIFF_REASONS.ADDED])
})
