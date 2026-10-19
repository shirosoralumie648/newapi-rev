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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  applyPlaygroundMessagesDelta,
  createPlaygroundSession,
  deletePlaygroundSession,
  getPlaygroundAttachmentContent,
} from '../../api'
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_PARAMETER_ENABLED,
} from '../../constants'
import type { PlaygroundSession } from '../../types'
import { uploadPlaygroundAttachmentDirect } from '../attachment-upload'
import {
  forkPlaygroundSession,
  importPlaygroundSessionDocument,
  parsePlaygroundSessionExport,
} from '../import'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    applyPlaygroundMessagesDelta: vi.fn(),
    createPlaygroundSession: vi.fn(),
    deletePlaygroundSession: vi.fn(),
    getPlaygroundAttachmentContent: vi.fn(),
  }
})

vi.mock('../attachment-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attachment-upload')>()
  return {
    ...actual,
    uploadPlaygroundAttachmentDirect: vi.fn(),
    uploadPlaygroundSpeechAttachment: vi.fn(),
  }
})

const exported = {
  exported_at: 1,
  session: {
    id: 'pgs_old',
    title: 'Imported chat',
    system_prompt: 'Be brief.',
    config: { model: 'import-model', temperature: 0.4 },
    parameter_enabled: { temperature: true },
    context: {
      history_limit: 12,
      token_budget: 0,
      auto_summarize: false,
      summary_model: '',
    },
    context_summary: null,
  },
  messages: [
    {
      client_key: 'm1',
      payload: {
        key: 'm1',
        from: 'user',
        versions: [
          {
            id: 'v1',
            content: 'Look at this',
            attachments: [
              {
                id: 'pgf_old',
                media_type: 'image/png',
                filename: 'photo.png',
                byte_size: 10,
              },
            ],
          },
        ],
      },
    },
    {
      client_key: 'm2',
      payload: {
        key: 'm2',
        from: 'assistant',
        status: 'complete',
        versions: [
          {
            id: 'v2',
            content: 'Half an answer',
            finishReason: 'length',
            requestId: 'req-old',
            usage: {
              promptTokens: 1,
              completionTokens: 2,
              totalTokens: 3,
            },
          },
        ],
      },
    },
  ],
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

test('parses the export contract and drops generation-only metadata', () => {
  const document = parsePlaygroundSessionExport(exported)

  expect(document).toMatchObject({
    title: 'Imported chat',
    sourceSessionId: 'pgs_old',
    config: { model: 'import-model', temperature: 0.4 },
    parameterEnabled: { temperature: true },
    systemPrompt: 'Be brief.',
    context: { historyLimit: 12, tokenBudget: 0 },
  })
  expect(document.messages[0].versions[0].attachments?.[0]).toMatchObject({
    id: 'pgf_old',
    mediaType: 'image/png',
    filename: 'photo.png',
    byteSize: 10,
  })
  expect(document.messages[1].versions[0]).toMatchObject({
    content: 'Half an answer',
    finishReason: 'length',
  })
  // The exporting account's consume log ids must not follow the copy.
  expect(document.messages[1].versions[0].requestId).toBeUndefined()
  expect(document.messages[1].versions[0].usage).toBeUndefined()
})

test('rejects exports with duplicate message keys or unusable payloads', () => {
  const duplicate = {
    ...exported,
    messages: [exported.messages[0], exported.messages[0]],
  }
  expect(() => parsePlaygroundSessionExport(duplicate)).toThrow(
    'Invalid conversation export.'
  )
  expect(() =>
    parsePlaygroundSessionExport({
      ...exported,
      messages: [{ client_key: 'm1', payload: { key: 'm1', from: 'user' } }],
    })
  ).toThrow('Invalid conversation export.')
  expect(() =>
    parsePlaygroundSessionExport({ session: exported.session })
  ).toThrow('Invalid conversation export.')
})

function mockCreatedSession(messageRevision = 0) {
  vi.mocked(createPlaygroundSession).mockResolvedValue({
    id: 'pgs_new',
    title: 'Imported chat',
    revision: 3,
    messageRevision,
  } as never)
}

test('same-account import re-uploads attachments into the new conversation', async () => {
  mockCreatedSession()
  vi.mocked(getPlaygroundAttachmentContent).mockResolvedValue(
    new Blob(['image-bytes'], { type: 'image/png' })
  )
  vi.mocked(uploadPlaygroundAttachmentDirect).mockResolvedValue({
    id: 'pgf_new',
    sessionId: 'pgs_new',
    mediaType: 'image/png',
    filename: 'photo.png',
    byteSize: 11,
    createdAt: 1,
    updatedAt: 1,
  } as never)
  vi.mocked(applyPlaygroundMessagesDelta).mockResolvedValue(7)

  const document = parsePlaygroundSessionExport(exported)
  const result = await importPlaygroundSessionDocument(document)

  expect(createPlaygroundSession).toHaveBeenCalledWith(
    expect.objectContaining({
      client_id: expect.any(String),
      title: 'Imported chat',
      config: document.config,
      system_prompt: 'Be brief.',
    }),
    undefined
  )
  expect(getPlaygroundAttachmentContent).toHaveBeenCalledWith(
    '/api/playground/sessions/pgs_old/attachments/pgf_old/content',
    undefined
  )
  expect(uploadPlaygroundAttachmentDirect).toHaveBeenCalledWith(
    { sessionId: 'pgs_new' },
    expect.any(File),
    undefined
  )
  const delta = vi.mocked(applyPlaygroundMessagesDelta).mock.calls[0][1]
  expect(delta.upserts[0].versions[0].attachments?.[0]).toMatchObject({
    id: 'pgf_new',
    url: '/api/playground/sessions/pgs_new/attachments/pgf_new/content',
  })
  expect(delta.upserts[0].versions[0].content).toBe('Look at this')
  expect(result.unavailableAttachments).toBe(0)
  expect(result.session).toMatchObject({
    id: expect.any(String),
    title: 'Imported chat',
    server: { id: 'pgs_new', revision: 3, messageRevision: 7 },
    syncPending: false,
  })
})

test('cross-account import keeps a placeholder instead of an unreachable attachment', async () => {
  mockCreatedSession()
  vi.mocked(getPlaygroundAttachmentContent).mockRejectedValue(
    new Error('Playground attachment not found.')
  )
  vi.mocked(applyPlaygroundMessagesDelta).mockResolvedValue(1)

  const result = await importPlaygroundSessionDocument(
    parsePlaygroundSessionExport(exported)
  )

  expect(uploadPlaygroundAttachmentDirect).not.toHaveBeenCalled()
  const delta = vi.mocked(applyPlaygroundMessagesDelta).mock.calls[0][1]
  expect(delta.upserts[0].versions[0].attachments).toBeUndefined()
  expect(delta.upserts[0].versions[0].content).toBe(
    'Look at this\n\n[attachment unavailable after import: photo.png]'
  )
  expect(result.unavailableAttachments).toBe(1)
})

test('a failed message write removes the freshly created session', async () => {
  mockCreatedSession()
  vi.mocked(getPlaygroundAttachmentContent).mockRejectedValue(
    new Error('Playground attachment not found.')
  )
  vi.mocked(applyPlaygroundMessagesDelta).mockRejectedValue(
    new Error('Playground message limit exceeded.')
  )
  vi.mocked(deletePlaygroundSession).mockResolvedValue(undefined)

  await expect(
    importPlaygroundSessionDocument(parsePlaygroundSessionExport(exported))
  ).rejects.toThrow('Playground message limit exceeded.')

  expect(deletePlaygroundSession).toHaveBeenCalledWith('pgs_new')
})
