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
import type { FileUIPart } from 'ai'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import type { Message } from '../../types'
import {
  clearPlaygroundAttachmentCache,
  ensurePlaygroundMessageAttachments,
  getPlaygroundAttachmentDataUrl,
  primePlaygroundAttachment,
} from '../attachment-store'
import {
  PLAYGROUND_ATTACHMENT_ERRORS,
  uploadPlaygroundAttachments,
  uploadPlaygroundSpeechAttachment,
} from '../attachment-upload'
import { buildChatCompletionPayload } from '../streaming/payload-builder'

const pngBase64 = 'iVBORw0KGgo='

function inputFile(
  overrides: Partial<FileUIPart & { id?: string }> = {}
): FileUIPart & { id?: string } {
  return {
    id: 'file-1',
    type: 'file',
    url: `data:image/png;base64,${pngBase64}`,
    mediaType: 'image/png',
    filename: 'photo.png',
    ...overrides,
  }
}

const attachedMessage: Message = {
  key: 'm1',
  from: 'user',
  versions: [
    {
      id: 'v1',
      content: 'look',
      attachments: [
        {
          id: 'pgf_1',
          url: '/api/playground/sessions/pgs/attachments/pgf_1/content',
          mediaType: 'image/png',
          filename: 'photo.png',
        },
      ],
    },
  ],
}

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
  clearPlaygroundAttachmentCache()
  vi.restoreAllMocks()
})

test('uploads each input file once with its client key and primes the byte cache', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (_url, body) => {
    const input = body as {
      client_key: string
      media_type: string
      filename?: string
    }
    return {
      data: {
        success: true,
        data: {
          created: true,
          id: 'pgf_1',
          client_key: input.client_key,
          session_id: 'pgs_server',
          media_type: input.media_type,
          filename: input.filename,
          byte_size: 8,
          created_at: 1,
          updated_at: 1,
        },
      },
    }
  })

  const attachments = await uploadPlaygroundAttachments('pgs_server', [
    inputFile(),
  ])

  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0]?.[0]).toBe(
    '/api/playground/sessions/pgs_server/attachments'
  )
  expect(post.mock.calls[0]?.[1]).toMatchObject({
    client_key: 'file-1',
    media_type: 'image/png',
    filename: 'photo.png',
    data: pngBase64,
  })
  expect(attachments).toEqual([
    {
      id: 'pgf_1',
      url: '/api/playground/sessions/pgs_server/attachments/pgf_1/content',
      mediaType: 'image/png',
      filename: 'photo.png',
      byteSize: 8,
    },
  ])
  expect(getPlaygroundAttachmentDataUrl('pgf_1')).toBe(
    `data:image/png;base64,${pngBase64}`
  )
})

test('cached speech uploads as an audio attachment with a matching filename', async () => {
  const post = vi.spyOn(api, 'post').mockImplementation(async (_url, body) => {
    const input = body as {
      client_key: string
      media_type: string
      filename?: string
    }
    return {
      data: {
        success: true,
        data: {
          created: true,
          id: 'pgf_speech',
          client_key: input.client_key,
          session_id: 'pgs_server',
          media_type: input.media_type,
          filename: input.filename,
          byte_size: 11,
          created_at: 1,
          updated_at: 1,
        },
      },
    }
  })

  const attachment = await uploadPlaygroundSpeechAttachment(
    'pgs_server',
    new Blob(['audio bytes'], { type: 'audio/mpeg' })
  )

  expect(post.mock.calls[0]?.[0]).toBe(
    '/api/playground/sessions/pgs_server/attachments'
  )
  expect(post.mock.calls[0]?.[1]).toMatchObject({
    media_type: 'audio/mpeg',
    filename: 'speech.mp3',
  })
  expect(attachment).toEqual({
    id: 'pgf_speech',
    url: '/api/playground/sessions/pgs_server/attachments/pgf_speech/content',
    mediaType: 'audio/mpeg',
    filename: 'speech.mp3',
    byteSize: 11,
  })
  expect(getPlaygroundAttachmentDataUrl('pgf_speech')).toBe(
    'data:audio/mpeg;base64,YXVkaW8gYnl0ZXM='
  )
})

test('rejects unreadable payloads and oversized batches before uploading', async () => {
  const post = vi.spyOn(api, 'post')

  await expect(
    uploadPlaygroundAttachments('pgs_server', [
      inputFile({ url: 'blob:not-a-data-url' }),
    ])
  ).rejects.toThrow(PLAYGROUND_ATTACHMENT_ERRORS.UNREADABLE)

  const tooMany = Array.from({ length: 9 }, (_, index) =>
    inputFile({ id: `file-${index}` })
  )
  await expect(
    uploadPlaygroundAttachments('pgs_server', tooMany)
  ).rejects.toThrow(PLAYGROUND_ATTACHMENT_ERRORS.TOO_MANY)

  expect(post).not.toHaveBeenCalled()
})

test('outgoing payloads turn cached attachments into image parts', () => {
  primePlaygroundAttachment('pgf_1', `data:image/png;base64,${pngBase64}`)
  const payload = buildChatCompletionPayload(
    [attachedMessage],
    DEFAULT_CONFIG,
    DEFAULT_PARAMETER_ENABLED
  )
  expect(payload.messages[0].content).toEqual([
    { type: 'text', text: 'look' },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${pngBase64}` },
    },
  ])

  // Without cached bytes the same history still sends as plain text.
  clearPlaygroundAttachmentCache()
  const fallback = buildChatCompletionPayload(
    [attachedMessage],
    DEFAULT_CONFIG,
    DEFAULT_PARAMETER_ENABLED
  )
  expect(fallback.messages[0].content).toBe('look')
})

test('loads missing attachment bytes once and reuses them for later sends', async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
    type: 'image/png',
  })
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: blob })

  await ensurePlaygroundMessageAttachments([attachedMessage])
  await ensurePlaygroundMessageAttachments([attachedMessage])

  expect(get).toHaveBeenCalledTimes(1)
  expect(get).toHaveBeenCalledWith(
    attachedMessage.versions[0].attachments?.[0]?.url,
    expect.objectContaining({ responseType: 'blob' })
  )
  expect(getPlaygroundAttachmentDataUrl('pgf_1')).toMatch(
    /^data:image\/png;base64,/
  )
})
