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

import type { ChatCompletionRequest, ContentPart } from '../../../types'
import {
  buildPlaygroundCurlCode,
  buildPlaygroundMessagesJson,
  buildPlaygroundNodeCode,
  buildPlaygroundPythonCode,
  buildPlaygroundRequestCode,
  normalizePlaygroundRequestBaseUrl,
  redactPlaygroundRequest,
} from '../request-code'

const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const DATA_URL = `data:image/png;base64,${PIXEL_PNG_BASE64}`
const REMOTE_URL = 'https://cdn.example.com/photo.png'
const BASE_URL = 'https://api.example.com/'

const userParts: ContentPart[] = [
  { type: 'text', text: "Please describe it's colors" },
  { type: 'image_url', image_url: { url: DATA_URL } },
  { type: 'image_url', image_url: { url: REMOTE_URL } },
]

const payload: ChatCompletionRequest = {
  model: 'gpt-4o',
  group: 'default',
  stream: false,
  temperature: 0.2,
  max_tokens: 256,
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: userParts },
  ],
}

test('the Messages JSON export swaps inline image bytes for a file placeholder and keeps remote URLs', () => {
  const json = buildPlaygroundMessagesJson(payload)
  const exported = JSON.parse(json) as ChatCompletionRequest
  const parts = exported.messages[1].content as ContentPart[]

  expect(parts[1].image_url?.url).toBe('attachment://attachment-1.png')
  expect(parts[2].image_url?.url).toBe(REMOTE_URL)
  expect(json).not.toContain(PIXEL_PNG_BASE64)
  // The captured payload of the workspace is never mutated by an export.
  expect(userParts[1].image_url?.url).toBe(DATA_URL)
})

test('the same inline data URL always maps to the same attachment placeholder', () => {
  const redaction = redactPlaygroundRequest({
    ...payload,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: DATA_URL } },
          { type: 'image_url', image_url: { url: DATA_URL } },
        ],
      },
    ],
  })
  const parts = redaction.payload.messages[0].content as ContentPart[]

  expect(redaction.attachments).toHaveLength(1)
  expect(redaction.attachments[0].filename).toBe('attachment-1.png')
  expect(parts[0].image_url?.url).toBe('attachment://attachment-1.png')
  expect(parts[1].image_url?.url).toBe('attachment://attachment-1.png')
})

test('the cURL export is a runnable command with a placeholder key and a shell-quoted body', () => {
  const code = buildPlaygroundCurlCode(payload, BASE_URL)

  expect(code).toContain("curl 'https://api.example.com/v1/chat/completions'")
  expect(code).toContain('-H "Authorization: Bearer $NEWAPI_API_KEY"')
  // A single quote inside the body stays one shell argument.
  expect(code).toContain("it'\\''s colors")
  expect(code).toContain('attachment://attachment-1.png')
  expect(code).toContain('"group" is a Playground-only routing field')
  expect(code).not.toContain(PIXEL_PNG_BASE64)
})

test('the Python export reads attachment bytes from disk instead of embedding base64', () => {
  const code = buildPlaygroundPythonCode(payload, BASE_URL)

  expect(code).toContain('api_key="$NEWAPI_API_KEY"')
  expect(code).toContain('base_url="https://api.example.com/v1"')
  expect(code).toContain(
    '_attachment_data_url("attachment-1.png", "image/png")'
  )
  expect(code).toContain(`"${REMOTE_URL}"`)
  expect(code).toContain('temperature=0.2')
  expect(code).not.toContain(PIXEL_PNG_BASE64)
})

test('the Node export reads attachment bytes from disk instead of embedding base64', () => {
  const code = buildPlaygroundNodeCode(payload, BASE_URL)

  expect(code).toContain('apiKey: "$NEWAPI_API_KEY"')
  expect(code).toContain('baseURL: "https://api.example.com/v1"')
  expect(code).toContain('attachmentDataUrl("attachment-1.png", "image/png")')
  expect(code).not.toContain(PIXEL_PNG_BASE64)
})

test('each tab dispatches to its own builder and the base URL keeps a fallback', () => {
  expect(buildPlaygroundRequestCode('messages', payload, BASE_URL)).toBe(
    buildPlaygroundMessagesJson(payload)
  )
  expect(buildPlaygroundRequestCode('curl', payload, BASE_URL)).toBe(
    buildPlaygroundCurlCode(payload, BASE_URL)
  )
  expect(buildPlaygroundRequestCode('python', payload, BASE_URL)).toBe(
    buildPlaygroundPythonCode(payload, BASE_URL)
  )
  expect(buildPlaygroundRequestCode('node', payload, BASE_URL)).toBe(
    buildPlaygroundNodeCode(payload, BASE_URL)
  )
  expect(normalizePlaygroundRequestBaseUrl(BASE_URL)).toBe(
    'https://api.example.com'
  )
  expect(normalizePlaygroundRequestBaseUrl('   ')).toBe(
    'https://your-new-api-host'
  )
})
