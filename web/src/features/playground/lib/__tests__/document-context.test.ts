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

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { api } from '@/lib/api'
import { createServerError } from '@/lib/server-error-message'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import type { Message } from '../../types'
import { ensurePlaygroundDocumentTexts } from '../document-context'
import { buildChatCompletionPayload } from '../streaming/payload-builder'

function documentMessage(id: string, filename = 'notes.md'): Message {
  return {
    key: `message-${id}`,
    from: 'user',
    versions: [
      {
        id: `version-${id}`,
        content: 'summarize',
        attachments: [
          {
            id,
            url: `/api/playground/sessions/pgs/attachments/${id}/content`,
            mediaType: 'text/markdown',
            filename,
          },
        ],
      },
    ],
  }
}

function documentReply(id: string, filename: string, text: string) {
  return {
    data: {
      success: true,
      data: {
        id,
        filename,
        media_type: 'text/markdown',
        text,
        byte_size: text.length,
        page_count: 0,
      },
    },
  }
}

function payloadContent(message: Message) {
  const payload = buildChatCompletionPayload(
    [message],
    DEFAULT_CONFIG,
    DEFAULT_PARAMETER_ENABLED
  )
  return payload.messages[0].content
}

afterEach(() => {
  mocks.toastError.mockReset()
  vi.restoreAllMocks()
})

test('adds the extracted document text to the payload and reads it once', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue(documentReply('pgf_doc_one', 'notes.md', 'Hello notes'))

  const message = documentMessage('pgf_doc_one')
  await ensurePlaygroundDocumentTexts([message])
  await ensurePlaygroundDocumentTexts([message])

  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0]?.[0]).toBe(
    '/api/playground/sessions/pgs/attachments/pgf_doc_one/text'
  )
  expect(payloadContent(message)).toBe(
    'summarize\n\n[document: notes.md]\nHello notes\n[/document]'
  )
})

test('keeps the placeholder and reports once when the server rejects the document', async () => {
  const get = vi.spyOn(api, 'get').mockRejectedValue(
    createServerError({
      success: false,
      code: 'PLAYGROUND_DOCUMENT_NO_TEXT',
      message_key: 'The document contains no extractable text.',
    })
  )

  const message = documentMessage('pgf_doc_terminal')
  await ensurePlaygroundDocumentTexts([message])
  await ensurePlaygroundDocumentTexts([message])

  expect(get).toHaveBeenCalledTimes(1)
  expect(mocks.toastError).toHaveBeenCalledTimes(1)
  expect(payloadContent(message)).toBe(
    'summarize\n\n[document: notes.md could not be read as text]'
  )
})

test('retries a document without a server outcome and reports it once', async () => {
  const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('Network Error'))

  const message = documentMessage('pgf_doc_transient')
  await ensurePlaygroundDocumentTexts([message])
  await ensurePlaygroundDocumentTexts([message])

  expect(get).toHaveBeenCalledTimes(2)
  expect(mocks.toastError).toHaveBeenCalledTimes(1)
})
