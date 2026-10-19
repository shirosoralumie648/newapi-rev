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
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  createCanvasWorkflowRunHistory,
  createGlobalCanvasTemplate,
  exportCanvasArchive,
  importCanvasArchive,
  lookupCanvasWorkflowNodeCache,
  updateCanvasWorkflowRunHistory,
} from '../api'

afterEach(() => vi.restoreAllMocks())

test('a whole-canvas export reads the blob and the RFC 5987 filename', async () => {
  const blob = new Blob(['zip-bytes'], { type: 'application/zip' })
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: blob,
    headers: {
      'content-disposition':
        "attachment; filename*=utf-8''%E7%94%BB%E6%9D%BF.zip",
    },
  })

  const archive = await exportCanvasArchive('pgc_1')

  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][0]).toBe('/api/playground/canvases/pgc_1/export')
  expect(get.mock.calls[0][1]).toEqual({
    params: undefined,
    responseType: 'blob',
    signal: undefined,
  })
  expect(archive.blob).toBe(blob)
  expect(archive.filename).toBe('画板.zip')
})

test('a selection export sends the picked node ids and prefers the quoted filename', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: new Blob(['zip-bytes'], { type: 'application/zip' }),
    headers: { 'content-disposition': 'attachment; filename="Board.zip"' },
  })

  const archive = await exportCanvasArchive('pgc_1', ['n1', 'n2'])

  expect(get.mock.calls[0][1]).toEqual({
    params: { nodes: 'n1,n2' },
    responseType: 'blob',
    signal: undefined,
  })
  expect(archive.filename).toBe('Board.zip')
})

test('an export without a filename header falls back to canvas.zip', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: new Blob([]), headers: {} })

  const archive = await exportCanvasArchive('pgc_1')

  expect(archive.filename).toBe('canvas.zip')
})

test('a failed archive download decodes a JSON error body wrapped in a Blob', async () => {
  const failure = Object.assign(new Error('Request failed'), {
    response: {
      data: new Blob(
        [
          JSON.stringify({
            success: false,
            message: 'Invalid Playground canvas archive.',
          }),
        ],
        { type: 'application/json' }
      ),
    },
  })
  vi.spyOn(api, 'get').mockRejectedValue(failure)

  await expect(exportCanvasArchive('pgc_1')).rejects.toBe(failure)
  expect(
    (failure.response.data as unknown as { message?: string }).message
  ).toBe('Invalid Playground canvas archive.')
})

test('a non-JSON failure body keeps the original error', async () => {
  const body = new Blob(['upstream error'], { type: 'text/plain' })
  const failure = Object.assign(new Error('Request failed'), {
    response: { data: body },
  })
  vi.spyOn(api, 'get').mockRejectedValue(failure)

  await expect(exportCanvasArchive('pgc_1')).rejects.toBe(failure)
  expect(failure.response.data).toBe(body)
})

test('an archive import posts the file as form data and maps the restore report', async () => {
  const file = new File(['zip-bytes'], 'board.zip', {
    type: 'application/zip',
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        project: {
          id: 'pgc_new',
          title: 'Board',
          node_count: 2,
          edge_count: 1,
          document_bytes: 256,
          revision: 0,
          created_at: 10,
          updated_at: 20,
          document: { nodes: [], edges: [] },
        },
        resources_imported: 1,
        resources_missing: 0,
        references_dropped: 0,
      },
    },
  })

  const result = await importCanvasArchive(file)

  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][0]).toBe('/api/playground/canvases/import')
  const form = post.mock.calls[0][1] as FormData
  expect(form).toBeInstanceOf(FormData)
  expect(form.get('file')).toBe(file)
  expect(result).toEqual({
    project: expect.objectContaining({
      id: 'pgc_new',
      title: 'Board',
      nodeCount: 2,
      edgeCount: 1,
      createdAt: 10000,
      updatedAt: 20000,
      document: { nodes: [], edges: [] },
    }),
    resourcesImported: 1,
    resourcesMissing: 0,
    referencesDropped: 0,
  })
})

test('an import the server rejects surfaces its message instead of a project', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'Invalid Playground canvas archive.' },
  })

  await expect(
    importCanvasArchive(new File(['nope'], 'nope.zip'))
  ).rejects.toThrow('Invalid Playground canvas archive.')
})

test('saving a global template posts to the administrator endpoint and maps the row', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        template: {
          id: 'pgct_global',
          name: 'Shared chain',
          description: '',
          category: 'translation',
          visibility: 'global',
          inline_assets: true,
          node_count: 3,
          edge_count: 2,
          document_bytes: 512,
          asset_count: 1,
          asset_bytes: 2048,
          created_at: 10,
          updated_at: 20,
        },
        assets_inlined: 1,
        resources_missing: 2,
        references_dropped: 1,
      },
    },
  })

  const result = await createGlobalCanvasTemplate({
    canvasId: 'pgc_1',
    name: 'Shared chain',
    inlineAssets: true,
  })

  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][0]).toBe('/api/playground/canvas-templates/global')
  expect(post.mock.calls[0][1]).toEqual({
    canvas_id: 'pgc_1',
    name: 'Shared chain',
    description: undefined,
    category: undefined,
    inline_assets: true,
  })
  expect(result).toEqual({
    template: expect.objectContaining({
      id: 'pgct_global',
      visibility: 'global',
      inlineAssets: true,
      assetCount: 1,
      createdAt: 10000,
      updatedAt: 20000,
    }),
    assetsInlined: 1,
    resourcesMissing: 2,
    referencesDropped: 1,
  })
})

const workflowRunPayload = {
  id: 'pgwr_1',
  canvas_id: 'pgc_1',
  session_id: '',
  workflow_revision: 4,
  status: 'running',
  node_count: 1,
  cache_hits: 0,
  total_quota: 25,
  prompt_tokens: 10,
  completion_tokens: 2,
  total_tokens: 12,
  duration_ms: 200,
  estimate_quota: 90,
  budget_cap: 0,
  byte_size: 128,
  revision: 1,
  created_at: 10,
  updated_at: 20,
  nodes: [
    {
      node_id: 'm1',
      kind: 'model',
      model: 'gpt-4o',
      group: 'default',
      status: 'succeeded',
      fingerprint: 'wf1:model-a',
      cache_hit: false,
      output: 'answer',
      task_id: '',
      artifact_keys: [],
      result_count: 0,
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      quota: 25,
      duration_ms: 200,
      error: '',
      started_at: 1000,
      finished_at: 1200,
    },
  ],
}

test('creating run history posts the start metadata and maps the stored run', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: workflowRunPayload },
  })

  const created = await createCanvasWorkflowRunHistory({
    canvasId: 'pgc_1',
    workflowRevision: 4,
    estimateQuota: 90,
    budgetCap: 0,
  })

  expect(post.mock.calls[0][0]).toBe('/api/playground/workflows/history')
  expect(post.mock.calls[0][1]).toEqual({
    canvas_id: 'pgc_1',
    workflow_revision: 4,
    estimate_quota: 90,
    budget_cap: 0,
  })
  expect(created).toMatchObject({
    id: 'pgwr_1',
    canvasId: 'pgc_1',
    createdAt: 10000,
    updatedAt: 20000,
    nodes: [expect.objectContaining({ nodeId: 'm1', quota: 25 })],
  })
})

test('updating run history sends snake_case nodes and the cache lookup maps seconds', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({
    data: {
      success: true,
      data: { ...workflowRunPayload, revision: 2, status: 'completed' },
    },
  })
  await updateCanvasWorkflowRunHistory('pgwr_1', {
    revision: 1,
    status: 'completed',
    nodes: [
      {
        nodeId: 'm1',
        kind: 'model',
        model: 'gpt-4o',
        group: 'default',
        status: 'succeeded',
        fingerprint: 'wf1:model-a',
        cacheHit: true,
        output: 'answer',
        taskId: '',
        artifactKeys: [],
        resultCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        quota: 0,
        durationMs: 200,
        error: '',
        startedAt: 1000,
        finishedAt: 1200,
      },
    ],
  })
  expect(patch.mock.calls[0][0]).toBe(
    '/api/playground/workflows/history/pgwr_1'
  )
  expect(patch.mock.calls[0][1]).toMatchObject({
    revision: 1,
    status: 'completed',
    nodes: [
      expect.objectContaining({
        node_id: 'm1',
        cache_hit: true,
        started_at: 1000,
      }),
    ],
  })

  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [
          {
            fingerprint: 'wf1:model-a',
            node_id: 'm1',
            kind: 'model',
            model: 'gpt-4o',
            output: 'answer',
            task_id: '',
            artifact_keys: [],
            result_count: 0,
            quota: 25,
            run_id: 'pgwr_1',
            updated_at: 20,
          },
        ],
      },
    },
  })
  const entries = await lookupCanvasWorkflowNodeCache('pgc_1', ['wf1:model-a'])
  expect(post.mock.calls[0][0]).toBe('/api/playground/workflows/node-cache')
  expect(post.mock.calls[0][1]).toEqual({
    canvas_id: 'pgc_1',
    fingerprints: ['wf1:model-a'],
  })
  expect(entries[0]).toMatchObject({
    fingerprint: 'wf1:model-a',
    updatedAt: 20000,
    runId: 'pgwr_1',
  })
})
