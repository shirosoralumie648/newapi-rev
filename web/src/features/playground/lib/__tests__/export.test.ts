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

import { exportPlaygroundSessionFile } from '../export'

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
