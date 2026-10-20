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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  getPlaygroundArenaVoteSummary,
  listPlaygroundArenaVotes,
  savePlaygroundArenaVote,
} from '../arena-api'

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: apiMock }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listPlaygroundArenaVotes', () => {
  test('loads the caller votes of one conversation and maps them to camelCase', async () => {
    const signal = new AbortController().signal
    apiMock.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          votes: [
            {
              id: 7,
              message_key: 'group-1',
              choice: 'both_bad',
              note: 'Neither is usable.',
              created_at: 100,
              updated_at: 200,
            },
          ],
        },
      },
    })

    const votes = await listPlaygroundArenaVotes('session/one', signal)

    expect(apiMock.get).toHaveBeenCalledWith(
      '/api/playground/sessions/session%2Fone/arena/votes',
      { signal }
    )
    expect(votes).toEqual([
      {
        id: 7,
        messageKey: 'group-1',
        choice: 'both_bad',
        note: 'Neither is usable.',
        createdAt: 100,
        updatedAt: 200,
      },
    ])
  })
})

describe('savePlaygroundArenaVote', () => {
  test('stores the raw choice and note with an encoded group key', async () => {
    apiMock.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          id: 9,
          message_key: 'group two',
          choice: 'tie',
          note: 'Same quality.',
          created_at: 101,
          updated_at: 202,
        },
      },
    })

    const vote = await savePlaygroundArenaVote(
      'session-1',
      'group two',
      'tie',
      'Same quality.'
    )

    expect(apiMock.put).toHaveBeenCalledWith(
      '/api/playground/sessions/session-1/arena/votes/group%20two',
      { choice: 'tie', note: 'Same quality.' },
      { signal: undefined }
    )
    expect(vote).toMatchObject({
      id: 9,
      messageKey: 'group two',
      choice: 'tie',
      note: 'Same quality.',
    })
  })
})

describe('getPlaygroundArenaVoteSummary', () => {
  test('reads the chosen scope and maps both_bad to bothBad', async () => {
    apiMock.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          scope: 'instance',
          total: 6,
          choices: { a: 2, b: 1, tie: 1, both_bad: 2 },
          notes: 3,
        },
      },
    })

    const summary = await getPlaygroundArenaVoteSummary('instance')

    expect(apiMock.get).toHaveBeenCalledWith('/api/playground/arena/summary', {
      params: { scope: 'instance' },
      signal: undefined,
    })
    expect(summary).toEqual({
      scope: 'instance',
      total: 6,
      choices: { a: 2, b: 1, tie: 1, bothBad: 2 },
      notes: 3,
    })
  })

  test('rejects a malformed summary instead of rendering partial totals', async () => {
    apiMock.get.mockResolvedValue({
      data: {
        success: true,
        data: { scope: 'personal', total: 1, choices: { a: 1 }, notes: 0 },
      },
    })

    await expect(getPlaygroundArenaVoteSummary('personal')).rejects.toThrow()
  })
})
