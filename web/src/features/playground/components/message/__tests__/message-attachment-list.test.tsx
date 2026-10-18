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
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { clearPlaygroundAttachmentCache } from '../../../lib'
import { MessageAttachmentList } from '../message-attachment-list'

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    Attachment: 'Attachment',
  })
})

if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => `blob:test-${Math.random()}`,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: () => undefined,
  })
}

afterEach(() => {
  clearPlaygroundAttachmentCache()
  vi.restoreAllMocks()
})

test('image attachments load through the authenticated content endpoint', async () => {
  const contentUrl =
    '/api/playground/sessions/pgs_one/attachments/pgf_1/content'
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: 'image/png',
    }),
  })

  render(
    <MessageAttachmentList
      attachments={[
        {
          id: 'pgf_1',
          url: contentUrl,
          mediaType: 'image/png',
          filename: 'photo.png',
        },
      ]}
    />
  )

  expect(await screen.findByRole('img', { name: 'photo.png' })).toBeVisible()
  expect(get).toHaveBeenCalledWith(
    contentUrl,
    expect.objectContaining({ responseType: 'blob' })
  )
})

test('a missing attachment keeps its label and shows the placeholder', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('gone'))

  render(
    <MessageAttachmentList
      attachments={[
        {
          id: 'pgf_missing',
          url: '/api/playground/sessions/pgs_one/attachments/pgf_missing/content',
          mediaType: 'image/png',
          filename: 'gone.png',
        },
      ]}
    />
  )

  expect(screen.getByText('gone.png')).toBeVisible()
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByTitle('gone.png')).toBeVisible()
})

test('audio attachments play through the authenticated content endpoint', async () => {
  const contentUrl =
    '/api/playground/sessions/pgs_one/attachments/pgf_speech/content'
  vi.spyOn(api, 'get').mockResolvedValue({
    data: new Blob([new Uint8Array([0x49, 0x44, 0x33])], {
      type: 'audio/mpeg',
    }),
  })

  render(
    <MessageAttachmentList
      attachments={[
        {
          id: 'pgf_speech',
          url: contentUrl,
          mediaType: 'audio/mpeg',
          filename: 'speech.mp3',
        },
      ]}
    />
  )

  expect(await screen.findByLabelText('speech.mp3')).toBeVisible()
})
