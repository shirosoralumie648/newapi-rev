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
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { clearPlaygroundAttachmentCache } from '../../../lib'
import { MessageSpeech } from '../message-speech'

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

test('the cached speech loads and plays through the authenticated content endpoint', async () => {
  const contentUrl =
    '/api/playground/sessions/pgs_one/attachments/pgf_speech/content'
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: new Blob([new Uint8Array([0x49, 0x44, 0x33])], {
      type: 'audio/mpeg',
    }),
  })

  render(
    <MessageSpeech
      speech={{
        id: 'pgf_speech',
        url: contentUrl,
        mediaType: 'audio/mpeg',
        filename: 'speech.mp3',
      }}
    />
  )

  const player = screen.getByLabelText('speech.mp3')
  await waitFor(() => expect(player.getAttribute('src')).toContain('blob:'))
  expect(get).toHaveBeenCalledWith(
    contentUrl,
    expect.objectContaining({ responseType: 'blob' })
  )
})
