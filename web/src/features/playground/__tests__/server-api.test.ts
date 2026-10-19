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
  applyPlaygroundMessagesDelta,
  exportPlaygroundSession,
  getPlaygroundMessageCosts,
  getPlaygroundSessions,
  getPlaygroundTrash,
  getPlaygroundMessages,
  replacePlaygroundMessages,
  restorePlaygroundSession,
  sendChatCompletion,
  updatePlaygroundSession,
} from '../api'
import {
  createPlaygroundSessionShare,
  getSharedPlaygroundConversation,
  revokePlaygroundSessionShare,
} from '../share-api'
import type { Message } from '../types'

const wireSession = {
  id: 'pgs_one',
  client_id: 'local-one',
  title: 'Saved chat',
  config: { model: 'server-model' },
  parameter_enabled: { temperature: false },
  created_at: 10,
  updated_at: 20,
  revision: 1,
  message_revision: 2,
}

afterEach(() => vi.restoreAllMocks())

test('server session responses map timestamps and settings into workspace state', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: { items: [wireSession], total: 1 } },
  })
  const sessions = await getPlaygroundSessions()
  expect(sessions[0]).toMatchObject({
    id: 'pgs_one',
    clientId: 'local-one',
    createdAt: 10000,
    updatedAt: 20000,
    parameterEnabled: { temperature: false },
    revision: 1,
    messageRevision: 2,
  })
})

test('business failure does not return an empty successful session list', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: false, message: 'Database unavailable' },
  })
  await expect(getPlaygroundSessions()).rejects.toThrow('Database unavailable')
})

test('context settings and the compression node map from the wire shape', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [
          {
            ...wireSession,
            context: {
              history_limit: 10,
              token_budget: 5000,
              auto_summarize: true,
              summary_model: 'summary-model',
            },
            context_summary: {
              id: 'pgc_1',
              content: 'Earlier messages were compressed.',
              through_message_key: 'm1',
              message_count: 3,
              model: 'summary-model',
              created_at: 5,
              request_id: 'req-1',
              usage: {
                promptTokens: 10,
                completionTokens: 4,
                totalTokens: 14,
              },
            },
          },
        ],
        total: 1,
      },
    },
  })
  const sessions = await getPlaygroundSessions()
  expect(sessions[0].context).toEqual({
    historyLimit: 10,
    tokenBudget: 5000,
    autoSummarize: true,
    summaryModel: 'summary-model',
  })
  expect(sessions[0].contextSummary).toMatchObject({
    id: 'pgc_1',
    content: 'Earlier messages were compressed.',
    throughMessageKey: 'm1',
    messageCount: 3,
    model: 'summary-model',
    requestId: 'req-1',
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  })
})

test('session updates serialize context fields into the wire shape and clear the summary with null', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({
    data: { success: true, data: wireSession },
  })
  await updatePlaygroundSession('pgs_one', {
    revision: 1,
    context: {
      historyLimit: 9,
      tokenBudget: 1000,
      autoSummarize: true,
      summaryModel: 'summary-model',
    },
    context_summary: {
      id: 'pgc_1',
      content: 'Earlier messages.',
      throughMessageKey: 'm1',
      messageCount: 1,
      model: 'summary-model',
      createdAt: 5,
    },
  })
  expect(patch.mock.calls[0][1]).toMatchObject({
    context: {
      history_limit: 9,
      token_budget: 1000,
      auto_summarize: true,
      summary_model: 'summary-model',
    },
    context_summary: {
      id: 'pgc_1',
      through_message_key: 'm1',
      message_count: 1,
      created_at: 5,
    },
  })
  await updatePlaygroundSession('pgs_one', {
    revision: 2,
    context_summary: null,
  })
  expect(patch.mock.calls[1][1]).toMatchObject({ context_summary: null })
})

test('message snapshots retain their server revision and payload', async () => {
  const message = {
    key: 'm',
    from: 'user',
    versions: [{ id: 'v', content: 'Private text' }],
  }
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { revision: 2, messages: [{ client_key: 'm', payload: message }] },
    },
  })
  expect(await getPlaygroundMessages('pgs_one')).toEqual({
    revision: 2,
    messages: [message],
  })
})

test('message snapshots derive attachment urls from stored references', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        revision: 3,
        messages: [
          {
            client_key: 'm',
            payload: {
              key: 'm',
              from: 'user',
              versions: [
                {
                  id: 'v',
                  content: 'look',
                  attachments: [
                    {
                      id: 'pgf_1',
                      media_type: 'image/png',
                      filename: 'photo.png',
                      byte_size: 8,
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  })
  const snapshot = await getPlaygroundMessages('pgs_one')
  expect(snapshot.messages[0].versions[0].attachments).toEqual([
    {
      id: 'pgf_1',
      url: '/api/playground/sessions/pgs_one/attachments/pgf_1/content',
      mediaType: 'image/png',
      filename: 'photo.png',
      byteSize: 8,
    },
  ])
})

test('message snapshots derive the cached speech url from its reference', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        revision: 4,
        messages: [
          {
            client_key: 'm',
            payload: {
              key: 'm',
              from: 'assistant',
              versions: [
                {
                  id: 'v',
                  content: 'read me',
                  speech: {
                    id: 'pgf_speech',
                    media_type: 'audio/mpeg',
                    filename: 'speech.mp3',
                    byte_size: 128,
                  },
                },
              ],
            },
          },
        ],
      },
    },
  })
  const snapshot = await getPlaygroundMessages('pgs_one')
  expect(snapshot.messages[0].versions[0].speech).toEqual({
    id: 'pgf_speech',
    url: '/api/playground/sessions/pgs_one/attachments/pgf_speech/content',
    mediaType: 'audio/mpeg',
    filename: 'speech.mp3',
    byteSize: 128,
  })
})

test('an incremental delta is written through PATCH with only the changed rows', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({
    data: {
      success: true,
      data: { revision: 4, upserted: ['m2'], deleted: ['m1'] },
    },
  })
  const message: Message = {
    key: 'm2',
    from: 'user',
    versions: [{ id: 'v2', content: 'Edited' }],
  }

  const revision = await applyPlaygroundMessagesDelta(
    'pgs_one',
    { upserts: [message], deletes: ['m1'] },
    3
  )

  expect(revision).toBe(4)
  expect(patch).toHaveBeenCalledTimes(1)
  expect(patch.mock.calls[0][0]).toBe(
    '/api/playground/sessions/pgs_one/messages'
  )
  expect(patch.mock.calls[0][1]).toEqual({
    revision: 3,
    upserts: [{ client_key: 'm2', payload: message }],
    deletes: ['m1'],
  })
})

test('the deprecated snapshot endpoint still sends the complete ordered list', async () => {
  const message: Message = {
    key: 'm',
    from: 'user',
    versions: [{ id: 'v', content: 'Private text' }],
  }
  const put = vi.spyOn(api, 'put').mockResolvedValue({
    data: {
      success: true,
      data: { revision: 2, messages: [{ client_key: 'm', payload: message }] },
    },
  })

  const snapshot = await replacePlaygroundMessages('pgs_one', [message], 1)

  expect(snapshot).toEqual({ revision: 2, messages: [message] })
  expect(put).toHaveBeenCalledTimes(1)
  expect(put.mock.calls[0][0]).toBe('/api/playground/sessions/pgs_one/messages')
  expect(put.mock.calls[0][1]).toEqual({
    revision: 1,
    messages: [{ client_key: 'm', payload: message }],
  })
})

test('the cost lookup sends the request ids and maps settled rows by id', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        enabled: true,
        items: [
          {
            request_id: 'req-1',
            quota: 1234,
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            model_name: 'test-model',
            created_at: 100,
            timing: {
              total_ms: 1320,
              auth_ms: 24,
              channel_select_ms: 8,
              upstream_ms: 411,
              first_token_ms: 445,
              retries: 1,
            },
          },
        ],
      },
    },
  })

  const lookup = await getPlaygroundMessageCosts(['req-1', 'req-2'])

  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][0]).toBe('/api/playground/message-costs')
  expect(get.mock.calls[0][1]).toEqual({
    params: { request_ids: 'req-1,req-2' },
    signal: undefined,
  })
  expect(lookup.enabled).toBe(true)
  expect(lookup.costs.get('req-1')).toEqual({
    requestId: 'req-1',
    quota: 1234,
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    modelName: 'test-model',
    createdAt: 100000,
    timing: {
      total_ms: 1320,
      auth_ms: 24,
      channel_select_ms: 8,
      upstream_ms: 411,
      first_token_ms: 445,
      retries: 1,
    },
  })
  expect(lookup.costs.has('req-2')).toBe(false)
})

test('a failed cost lookup surfaces the server message instead of an empty map', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: false, message: 'Failed to query logs' },
  })

  await expect(getPlaygroundMessageCosts(['req-1'])).rejects.toThrow(
    'Failed to query logs'
  )
})

test('a non-streaming completion reports the relay request id header', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { id: 'chatcmpl-1', choices: [] },
    headers: { 'x-oneapi-request-id': 'req-9' },
  })

  const result = await sendChatCompletion({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  })

  expect(post).toHaveBeenCalledTimes(1)
  expect(result.requestId).toBe('req-9')
  expect(result.response).toEqual({ id: 'chatcmpl-1', choices: [] })
})

test('a conversation export keeps the server filename, media type and body', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        format: 'markdown',
        filename: 'Saved chat.md',
        content_type: 'text/markdown; charset=utf-8',
        content: '# Saved chat\n',
      },
    },
  })

  const exported = await exportPlaygroundSession('pgs_one', 'markdown')

  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][0]).toBe('/api/playground/sessions/pgs_one/export')
  expect(get.mock.calls[0][1]).toEqual({
    params: { format: 'markdown' },
    signal: undefined,
  })
  expect(exported).toEqual({
    format: 'markdown',
    filename: 'Saved chat.md',
    contentType: 'text/markdown; charset=utf-8',
    content: '# Saved chat\n',
  })
})

test('the trash listing keeps the retention window and maps purge deadlines to milliseconds', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        retention_days: 30,
        items: [
          {
            kind: 'session',
            id: 'pgs_one',
            title: 'Saved chat',
            deleted_at: 100,
            purge_at: 200,
          },
          {
            kind: 'canvas',
            id: 'pgc_one',
            title: 'Board',
            deleted_at: 300,
            purge_at: 400,
          },
        ],
      },
    },
  })

  const listing = await getPlaygroundTrash()

  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][0]).toBe('/api/playground/trash')
  expect(listing).toEqual({
    retentionDays: 30,
    items: [
      {
        kind: 'session',
        id: 'pgs_one',
        title: 'Saved chat',
        deletedAt: 100000,
        purgeAt: 200000,
      },
      {
        kind: 'canvas',
        id: 'pgc_one',
        title: 'Board',
        deletedAt: 300000,
        purgeAt: 400000,
      },
    ],
  })
})

test('restoring a conversation posts to the restore route and maps the refreshed row', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: wireSession },
  })

  const restored = await restorePlaygroundSession('pgs_one')

  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][0]).toBe('/api/playground/sessions/pgs_one/restore')
  expect(restored).toMatchObject({
    id: 'pgs_one',
    createdAt: 10000,
    updatedAt: 20000,
    revision: 1,
    messageRevision: 2,
  })
})

test('creating a share link sends the selected expiry and converts timestamps', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        token: 'share-token',
        url_path: '/share/share-token',
        expires_at: 300,
        created_at: 100,
      },
    },
  })

  const share = await createPlaygroundSessionShare('pgs_one', 7)

  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][0]).toBe('/api/playground/sessions/pgs_one/share')
  expect(post.mock.calls[0][1]).toEqual({ expires_in_days: 7 })
  expect(share).toEqual({
    token: 'share-token',
    urlPath: '/share/share-token',
    expiresAt: 300000,
    createdAt: 100000,
  })
})

test('revoking a share link deletes every active link of the conversation', async () => {
  const remove = vi.spyOn(api, 'delete').mockResolvedValue({
    data: { success: true, data: { revoked: true } },
  })

  await revokePlaygroundSessionShare('pgs_one')

  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove.mock.calls[0][0]).toBe('/api/playground/sessions/pgs_one/share')
})

test('the public share read maps only the sanitized snapshot', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        title: 'Public conversation',
        opening_message: 'Welcome',
        messages: [
          {
            key: 'm1',
            from: 'user',
            content: 'Hello',
            attachments: [{ filename: 'diagram.png', media_type: 'image/png' }],
          },
          {
            key: 'm2',
            from: 'assistant',
            content: 'Answer',
            tool_calls: [{ name: 'lookup', status: 'completed' }],
          },
        ],
      },
    },
  })

  const conversation = await getSharedPlaygroundConversation('share-token')

  expect(get.mock.calls[0][0]).toBe('/api/playground/shared/share-token')
  expect(conversation).toEqual({
    title: 'Public conversation',
    openingMessage: 'Welcome',
    messages: [
      {
        key: 'm1',
        from: 'user',
        content: 'Hello',
        toolCalls: [],
        attachments: [{ filename: 'diagram.png', mediaType: 'image/png' }],
      },
      {
        key: 'm2',
        from: 'assistant',
        content: 'Answer',
        toolCalls: [{ name: 'lookup', status: 'completed' }],
        attachments: [],
      },
    ],
  })
})

test('a failed public share read surfaces the server message', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: false,
      code: 'PLAYGROUND_SHARE_NOT_FOUND',
      message: 'Shared conversation not found.',
    },
  })

  await expect(getSharedPlaygroundConversation('share-token')).rejects.toThrow(
    'Shared conversation not found.'
  )
})
