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

import { createPlaygroundProtocolStreamParser } from '../protocol-stream'

function frame(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

describe('createPlaygroundProtocolStreamParser', () => {
  it('maps Responses text and reasoning deltas onto chat updates', () => {
    const parse = createPlaygroundProtocolStreamParser('responses')

    expect(
      parse(
        'response.output_text.delta',
        frame({ type: 'response.output_text.delta', delta: 'Hel' })
      )
    ).toMatchObject({ updates: [{ type: 'content', chunk: 'Hel' }] })
    expect(
      parse(
        'response.reasoning_summary_text.delta',
        frame({
          type: 'response.reasoning_summary_text.delta',
          delta: 'Thinking',
        })
      )
    ).toMatchObject({ updates: [{ type: 'reasoning', chunk: 'Thinking' }] })
  })

  it('collects Responses function call fragments by dense tool index', () => {
    const parse = createPlaygroundProtocolStreamParser('responses')

    expect(
      parse(
        'response.output_item.added',
        frame({
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'function_call', call_id: 'call_1', name: 'lookup' },
        })
      )
    ).toMatchObject({
      toolCalls: [
        {
          index: 0,
          id: 'call_1',
          function: { name: 'lookup', arguments: '' },
        },
      ],
    })
    expect(
      parse(
        'response.output_item.added',
        frame({
          type: 'response.output_item.added',
          output_index: 3,
          item: { type: 'function_call', call_id: 'call_2', name: 'search' },
        })
      )
    ).toMatchObject({
      toolCalls: [{ index: 1, id: 'call_2', function: { name: 'search' } }],
    })
    expect(
      parse(
        'response.function_call_arguments.delta',
        frame({
          type: 'response.function_call_arguments.delta',
          output_index: 3,
          delta: '{"q":"x"}',
        })
      )
    ).toMatchObject({
      toolCalls: [{ index: 1, function: { arguments: '{"q":"x"}' } }],
    })
  })

  it('completes Responses with usage and a length finish reason', () => {
    const parse = createPlaygroundProtocolStreamParser('responses')

    const outcome = parse(
      'response.completed',
      frame({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
          output: [{ type: 'function_call' }],
          incomplete_details: { reason: 'max_output_tokens' },
        },
      })
    )

    expect(outcome).toMatchObject({
      done: true,
      finishReason: 'length',
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    })
  })

  it('surfaces a Responses failure as a stream error', () => {
    const parse = createPlaygroundProtocolStreamParser('responses')

    expect(
      parse(
        'response.failed',
        frame({
          type: 'response.failed',
          response: {
            error: { code: 'convert_request_failed', message: 'No adapter' },
          },
        })
      )
    ).toMatchObject({
      error: {
        errorCode: 'convert_request_failed',
        errorMessage: 'No adapter',
      },
    })
  })

  it('maps Anthropic Messages text, tool use and usage frames', () => {
    const parse = createPlaygroundProtocolStreamParser('messages')

    parse(
      'message_start',
      frame({
        type: 'message_start',
        message: { usage: { input_tokens: 9, output_tokens: 0 } },
      })
    )
    expect(
      parse(
        'content_block_delta',
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        })
      )
    ).toMatchObject({ updates: [{ type: 'content', chunk: 'Hello' }] })
    expect(
      parse(
        'content_block_delta',
        frame({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'thinking_delta', thinking: 'Hmm' },
        })
      )
    ).toMatchObject({ updates: [{ type: 'reasoning', chunk: 'Hmm' }] })
    expect(
      parse(
        'content_block_start',
        frame({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup' },
        })
      )
    ).toMatchObject({
      toolCalls: [
        {
          index: 0,
          id: 'tool_1',
          function: { name: 'lookup', arguments: '' },
        },
      ],
    })
    expect(
      parse(
        'content_block_delta',
        frame({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
        })
      )
    ).toMatchObject({
      toolCalls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
    })
    expect(
      parse(
        'message_delta',
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        })
      )
    ).toMatchObject({
      finishReason: 'tool_calls',
      usage: { promptTokens: 9, completionTokens: 5, totalTokens: 14 },
    })
    expect(
      parse('message_stop', frame({ type: 'message_stop' }))
    ).toMatchObject({ done: true })
  })

  it('falls back to the payload type when the event name is absent', () => {
    const parse = createPlaygroundProtocolStreamParser('messages')

    expect(
      parse(
        '',
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        })
      )
    ).toMatchObject({ updates: [{ type: 'content', chunk: 'Hi' }] })
  })

  it('surfaces an Anthropic error frame with its type as the code', () => {
    const parse = createPlaygroundProtocolStreamParser('messages')

    expect(
      parse(
        'error',
        frame({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        })
      )
    ).toMatchObject({
      error: { errorCode: 'overloaded_error', errorMessage: 'Overloaded' },
    })
  })

  it('ignores unknown frames and the chat protocol', () => {
    expect(
      createPlaygroundProtocolStreamParser('chat')('message', '{}')
    ).toBeNull()
    expect(
      createPlaygroundProtocolStreamParser('messages')(
        'ping',
        frame({ type: 'ping' })
      )
    ).toBeNull()
  })
})
