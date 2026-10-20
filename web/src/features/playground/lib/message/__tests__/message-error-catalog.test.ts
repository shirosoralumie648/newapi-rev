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

import type { Message } from '../../../types'
import {
  getPlaygroundErrorCatalogEntry,
  normalizePlaygroundErrorCode,
} from '../message-error-catalog'
import { getMessageErrorState } from '../message-error-utils'

describe('playground error catalog', () => {
  test.each([
    ['context_length_exceeded', 'context-too-long', ['open-context', 'retry']],
    [
      'insufficient_user_quota',
      'insufficient-quota',
      ['open-wallet', 'switch-group'],
    ],
    ['token_rate_limit_exceeded', 'rate-limited', ['retry', 'switch-group']],
    [
      'image_not_supported',
      'vision-unsupported',
      ['remove-images', 'change-model'],
    ],
    ['content_filter', 'content-filtered', ['change-model']],
    [
      'invalid_api_type',
      'protocol-mismatch',
      ['use-chat-protocol', 'change-model'],
    ],
    [
      'channel:no_available_key',
      'service-unavailable',
      ['retry', 'switch-group'],
    ],
    [
      'PLAYGROUND_GROUP_FORBIDDEN',
      'forbidden',
      ['switch-group', 'change-model'],
    ],
    ['model_price_error', 'model-price', []],
  ] as Array<[string, string, string[]]>)(
    'maps the stable code %s to %s with its repair actions',
    (code, category, actions) => {
      const entry = getPlaygroundErrorCatalogEntry(code)

      expect(entry?.category).toBe(category)
      expect(entry?.actions).toEqual(actions)
      expect(entry?.titleKey).toBeTruthy()
      expect(entry?.descriptionKey).toBeTruthy()
    }
  )

  test('normalizes the case and whitespace of a stable code', () => {
    expect(normalizePlaygroundErrorCode('  PLAYGROUND_Conflict ')).toBe(
      'playground_conflict'
    )
    expect(
      getPlaygroundErrorCatalogEntry('Playground_Conflict')?.category
    ).toBe('conflict')
  })

  test.each([
    [
      'invalid_request_error',
      "This model's maximum context length is 128000 tokens.",
      'context-too-long',
    ],
    ['error', 'The model does not support image input.', 'vision-unsupported'],
    ['bad_request', 'Content policy violation detected.', 'content-filtered'],
    ['invalid_request', 'Rate limit exceeded, please retry.', 'rate-limited'],
    [
      'request_error',
      'Insufficient balance for this request.',
      'insufficient-quota',
    ],
    [
      'invalid_request_error',
      'Unsupported protocol for this channel.',
      'protocol-mismatch',
    ],
    ['error', 'No available channel for this model.', 'model-unavailable'],
    ['error', 'Upstream service unavailable.', 'service-unavailable'],
  ])(
    'refines the generic code %s from a recognizable message',
    (code, message, category) => {
      expect(getPlaygroundErrorCatalogEntry(code, message)?.category).toBe(
        category
      )
    }
  )

  test('an unknown specific code keeps the raw error instead of guessing', () => {
    expect(
      getPlaygroundErrorCatalogEntry(
        'some_new_upstream_code',
        "This model's maximum context length is 128000 tokens."
      )
    ).toBeNull()
  })

  test('a generic code with an unrecognized message falls back to raw text', () => {
    expect(
      getPlaygroundErrorCatalogEntry(
        'invalid_request_error',
        'The provider returned a custom refusal.'
      )
    ).toBeNull()
    expect(getPlaygroundErrorCatalogEntry()).toBeNull()
  })

  test('a known error exposes a static catalog entry with no upstream text', () => {
    const message: Message = {
      key: 'assistant-1',
      from: 'assistant',
      status: 'error',
      errorCode: 'context_length_exceeded',
      versions: [
        {
          id: 'v1',
          content:
            'Rejected by https://channel.example.com with key sk-secret-value',
        },
      ],
    }

    const state = getMessageErrorState(message, false)

    expect(state?.catalog?.category).toBe('context-too-long')
    expect(state?.catalog?.titleKey).not.toContain('channel.example.com')
    expect(state?.catalog?.descriptionKey).not.toContain('sk-secret-value')
    // The raw text stays available for an unknown-code fallback, but a known
    // code renders only the static catalog copy.
    expect(state?.content).toContain('sk-secret-value')
  })
})
