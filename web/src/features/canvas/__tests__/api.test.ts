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

import { exportCanvasArchive, importCanvasArchive } from '../api'

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
