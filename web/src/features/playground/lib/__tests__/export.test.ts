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
  exportPlaygroundPresetFile,
  exportPlaygroundSessionFile,
  exportPlaygroundSnippetFile,
} from '../export'

type Download = { filename: string; blob: Blob }

function captureDownloads() {
  const downloads: Download[] = []
  let currentBlob: Blob
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        currentBlob = blob
        return 'blob:playground-export'
      }),
      revokeObjectURL: vi.fn(),
    })
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      downloads.push({ filename: this.download, blob: currentBlob })
    }
  )
  return downloads
}

function readDownload(download: Download): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)), {
      once: true,
    })
    reader.addEventListener('error', () => reject(reader.error), { once: true })
    reader.readAsText(download.blob)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('downloads the served export under the filename the server suggested', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        format: 'json',
        filename: 'Saved chat.json',
        content_type: 'application/json; charset=utf-8',
        content: '{"title":"Saved chat"}',
      },
    },
  })
  const downloads = captureDownloads()

  await exportPlaygroundSessionFile('pgs_one', 'json')

  expect(downloads).toHaveLength(1)
  expect(downloads[0].filename).toBe('Saved chat.json')
  expect(downloads[0].blob.type).toBe('application/json; charset=utf-8')
  expect(await readDownload(downloads[0])).toBe('{"title":"Saved chat"}')
  expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith(
    'blob:playground-export'
  )
})

test('downloads a preset as the JSON document the import endpoint accepts', async () => {
  const content =
    '{"format":"new-api-playground-preset","version":1,"preset":{"name":"Reviewer"}}'
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        format: 'json',
        filename: 'Reviewer.json',
        content_type: 'application/json; charset=utf-8',
        content,
      },
    },
  })
  const downloads = captureDownloads()

  await exportPlaygroundPresetFile('pgp_reviewer', 'global')

  expect(get).toHaveBeenCalledWith(
    '/api/playground/presets/global/pgp_reviewer/export',
    expect.anything()
  )
  expect(downloads).toHaveLength(1)
  expect(downloads[0].filename).toBe('Reviewer.json')
  expect(downloads[0].blob.type).toBe('application/json; charset=utf-8')
  expect(await readDownload(downloads[0])).toBe(content)
})

test('downloads a snippet as the JSON document the import endpoint accepts', async () => {
  const content =
    '{"format":"new-api-playground-prompt-template","schema_version":1,"template":{"name":"Reviewer","production_version":1,"versions":[{"version":1,"content":"Review {{path}}","created_at":1700000000}]}}'
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        format: 'json',
        filename: 'Reviewer.json',
        content_type: 'application/json; charset=utf-8',
        content,
      },
    },
  })
  const downloads = captureDownloads()

  await exportPlaygroundSnippetFile('pgs_reviewer')

  expect(get).toHaveBeenCalledWith(
    '/api/playground/snippets/pgs_reviewer/export',
    expect.anything()
  )
  expect(downloads).toHaveLength(1)
  expect(downloads[0].filename).toBe('Reviewer.json')
  expect(downloads[0].blob.type).toBe('application/json; charset=utf-8')
  expect(await readDownload(downloads[0])).toBe(content)
})
