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
import { describe, expect, test } from 'vitest'

import {
  buildPlaygroundReplayHref,
  buildPlaygroundReplayLink,
  isPlaygroundReplayableLog,
} from '../replay'

describe('isPlaygroundReplayableLog', () => {
  test.each([
    ['/v1/chat/completions', 2],
    ['/v1/chat/completions', 5],
    ['/pg/chat/completions', 2],
    ['/v1/messages', 2],
    ['/v1/chat/completions/', 2],
    ['/v1/chat/completions?stream=true', 2],
  ])('replays a %s log of type %d', (path, type) => {
    expect(
      isPlaygroundReplayableLog(
        { type, request_id: 'req-1' },
        { request_path: path }
      )
    ).toBe(true)
  })

  test.each([
    ['/v1/images/generations', 2],
    ['/v1/embeddings', 2],
    ['/v1/audio/speech', 2],
    ['/v1/chat/completions', 1],
    ['/v1/chat/completions', 3],
    ['/v1/chat/completions', 7],
  ])('does not replay a %s log of type %d', (path, type) => {
    expect(
      isPlaygroundReplayableLog(
        { type, request_id: 'req-1' },
        { request_path: path }
      )
    ).toBe(false)
  })

  test('requires a request id and a recorded request path', () => {
    expect(
      isPlaygroundReplayableLog(
        { type: 2, request_id: '' },
        { request_path: '/v1/chat/completions' }
      )
    ).toBe(false)
    expect(
      isPlaygroundReplayableLog({ type: 2, request_id: 'req-1' }, null)
    ).toBe(false)
    expect(
      isPlaygroundReplayableLog({ type: 2, request_id: 'req-1' }, {} as never)
    ).toBe(false)
  })
})

describe('buildPlaygroundReplayLink', () => {
  test('links the replay to the log request id', () => {
    expect(
      buildPlaygroundReplayLink(
        { type: 2, request_id: 'req-42', user_id: 7 },
        { request_path: '/v1/chat/completions' }
      )
    ).toEqual({ replay: 'req-42' })
  })

  test('includes the owner only for an administrator viewing another account', () => {
    expect(
      buildPlaygroundReplayLink(
        { type: 2, request_id: 'req-42', user_id: 7 },
        { request_path: '/v1/chat/completions' },
        { includeOwner: true }
      )
    ).toEqual({ replay: 'req-42', replayUser: 7 })
  })

  test('has no link for a non-chat log', () => {
    expect(
      buildPlaygroundReplayLink(
        { type: 2, request_id: 'req-42', user_id: 7 },
        { request_path: '/v1/images/generations' }
      )
    ).toBeNull()
  })
})

describe('buildPlaygroundReplayHref', () => {
  test('builds the playground deep link with the owner when present', () => {
    expect(buildPlaygroundReplayHref({ replay: 'req-42', replayUser: 7 })).toBe(
      '/playground?replay=req-42&replayUser=7'
    )
  })

  test('omits the owner for the caller’s own log', () => {
    expect(buildPlaygroundReplayHref({ replay: 'req-42' })).toBe(
      '/playground?replay=req-42'
    )
  })
})
