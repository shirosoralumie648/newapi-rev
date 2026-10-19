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
import { describe, expect, it } from 'vitest'

import {
  parsePlaygroundProtocolCompletion,
  playgroundProtocolUnsupportedHint,
} from '../protocol-response'

describe('parsePlaygroundProtocolCompletion', () => {
  it('normalizes a Responses reply into a chat completion', () => {
    const response = parsePlaygroundProtocolCompletion('responses', {
      id: 'resp_1',
      model: 'gpt-5',
      created_at: 1700000000,
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Thinking' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

    expect(response.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Hello',
        reasoning_content: 'Thinking',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"x"}' },
          },
        ],
      },
    })
    expect(response.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })
  })

  it('maps an incomplete Responses reply to the length finish reason', () => {
    const response = parsePlaygroundProtocolCompletion('responses', {
      id: 'resp_2',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Partial' }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
      incomplete_details: { reason: 'max_output_tokens' },
    })

    expect(response.choices[0].finish_reason).toBe('length')
  })

  it('normalizes an Anthropic Messages reply with tool use', () => {
    const response = parsePlaygroundProtocolCompletion('messages', {
      id: 'msg_1',
      model: 'claude-sonnet',
      content: [
        { type: 'thinking', thinking: 'Considered' },
        { type: 'text', text: 'Hello' },
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'lookup',
          input: { q: 'x' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 4 },
    })

    expect(response.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: {
        content: 'Hello',
        reasoning_content: 'Considered',
        tool_calls: [
          {
            id: 'tool_1',
            function: { name: 'lookup', arguments: '{"q":"x"}' },
          },
        ],
      },
    })
    expect(response.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
    })
  })

  it('maps a max_tokens Messages stop onto length', () => {
    const response = parsePlaygroundProtocolCompletion('messages', {
      content: [{ type: 'text', text: 'Partial' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    expect(response.choices[0].finish_reason).toBe('length')
  })

  it('rejects a response body that is not a JSON object', () => {
    expect(() =>
      parsePlaygroundProtocolCompletion('messages', 'nope')
    ).toThrow()
  })
})

describe('playgroundProtocolUnsupportedHint', () => {
  it('suggests switching protocols when conversion fails', () => {
    expect(
      playgroundProtocolUnsupportedHint(
        'messages',
        'convert_request_failed',
        'conversion failed'
      )
    ).toContain('Switch back to Chat Completions')
  })

  it('recognizes an unsupported-capability message', () => {
    expect(
      playgroundProtocolUnsupportedHint(
        'responses',
        'invalid_request',
        'This channel does not support the Responses API'
      )
    ).not.toBeNull()
  })

  it('stays quiet for chat and unrelated failures', () => {
    expect(
      playgroundProtocolUnsupportedHint('chat', 'convert_request_failed')
    ).toBeNull()
    expect(
      playgroundProtocolUnsupportedHint('messages', 'rate_limit', 'Too many')
    ).toBeNull()
  })
})
