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

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import {
  buildPlaygroundReplayDraft,
  type PlaygroundLogReplay,
} from '../playground-replay'

function replay(
  overrides: Partial<PlaygroundLogReplay> = {}
): PlaygroundLogReplay {
  return { request_id: 'req-1', ...overrides }
}

describe('buildPlaygroundReplayDraft', () => {
  test('restores the parameters the log recorded', () => {
    const draft = buildPlaygroundReplayDraft(
      replay({
        model: 'claude-sonnet-4',
        group: 'vip',
        stream: false,
        sampling: {
          temperature: 0.2,
          top_p: 0.8,
          max_tokens: 1024,
          frequency_penalty: 0.1,
          presence_penalty: 0.3,
          seed: 7,
          reasoning_effort: 'high',
        },
      })
    )
    expect(draft.config).toEqual({
      ...DEFAULT_CONFIG,
      model: 'claude-sonnet-4',
      group: 'vip',
      stream: false,
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 1024,
      frequency_penalty: 0.1,
      presence_penalty: 0.3,
      seed: 7,
      reasoning_effort: 'high',
    })
    expect(draft.parameterEnabled).toEqual({
      temperature: true,
      top_p: true,
      max_tokens: true,
      frequency_penalty: true,
      presence_penalty: true,
      seed: true,
      reasoning_effort: true,
    })
  })

  test('keeps a parameter the record never held at its default and disabled', () => {
    const draft = buildPlaygroundReplayDraft(
      replay({ model: 'gpt-4o', sampling: { temperature: 0.5 } })
    )
    expect(draft.config.temperature).toBe(0.5)
    expect(draft.config.top_p).toBe(DEFAULT_CONFIG.top_p)
    expect(draft.config.max_tokens).toBe(DEFAULT_CONFIG.max_tokens)
    expect(draft.parameterEnabled).toEqual({
      ...DEFAULT_PARAMETER_ENABLED,
      temperature: true,
    })
  })

  test('keeps an explicit zero of a recorded parameter', () => {
    const draft = buildPlaygroundReplayDraft(
      replay({ sampling: { temperature: 0, seed: 0 } })
    )
    expect(draft.config.temperature).toBe(0)
    expect(draft.config.seed).toBe(0)
    expect(draft.parameterEnabled.temperature).toBe(true)
    expect(draft.parameterEnabled.seed).toBe(true)
  })

  test('prefills the last user message of the retained request', () => {
    const draft = buildPlaygroundReplayDraft(
      replay({
        content_available: true,
        capture: {
          request: {
            messages: [
              { role: 'system', content: 'You are helpful.' },
              { role: 'user', content: 'first question' },
              { role: 'assistant', content: 'first answer' },
              { role: 'user', content: 'second question' },
            ],
          },
        },
      })
    )
    expect(draft.text).toBe('second question')
    expect(draft.contentNotice).toBeNull()
  })

  test('ignores empty and non-text user turns', () => {
    const draft = buildPlaygroundReplayDraft(
      replay({
        content_available: true,
        capture: {
          request: {
            messages: [
              { role: 'user', content: '   ' },
              { role: 'user', content: { type: 'image' } },
            ],
          },
        },
      })
    )
    expect(draft.text).toBe('')
    expect(draft.contentNotice).toBeNull()
  })

  test.each([
    ['capture_disabled', true],
    ['expired', true],
    ['not_captured', true],
  ])('explains missing content (%s)', (reason) => {
    const draft = buildPlaygroundReplayDraft(
      replay({
        model: 'gpt-4o',
        content_available: false,
        content_unavailable_reason: reason,
        sampling: { reasoning_effort: 'medium' },
      })
    )
    expect(draft.contentNotice).toBeTruthy()
    expect(draft.contentNotice).not.toBe('capture_disabled')
    // The public reasoning effort still replays without stored content.
    expect(draft.config.reasoning_effort).toBe('medium')
    expect(draft.text).toBe('')
  })
})
