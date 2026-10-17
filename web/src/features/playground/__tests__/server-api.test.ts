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

import { getPlaygroundSessions, getPlaygroundMessages } from '../api'

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
