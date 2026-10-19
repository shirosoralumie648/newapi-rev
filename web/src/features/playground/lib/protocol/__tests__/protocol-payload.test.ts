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

import type { ChatCompletionRequest } from '../../../types'
import {
  buildPlaygroundProtocolRequest,
  playgroundProtocolUnsupportedFields,
} from '../protocol-payload'

const base: ChatCompletionRequest = {
  model: 'gpt-4o',
  group: 'vip',
  stream: true,
  messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hi' },
  ],
}

function bodyOf(request: ReturnType<typeof buildPlaygroundProtocolRequest>) {
  return request.body as Record<string, unknown>
}

describe('buildPlaygroundProtocolRequest', () => {
  it('keeps the chat payload untouched', () => {
    const request = buildPlaygroundProtocolRequest(base, 'chat')

    expect(request.endpoint).toBe('/pg/chat/completions')
    expect(request.body).toBe(base)
  })

  it('moves system instructions and sampling fields into the Responses shape', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        max_tokens: 128,
        temperature: 0.2,
        top_p: 0.9,
        reasoning_effort: 'high',
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
      },
      'responses'
    )

    expect(request.endpoint).toBe('/pg/responses')
    expect(bodyOf(request)).toMatchObject({
      model: 'gpt-4o',
      instructions: 'Be terse.',
      max_output_tokens: 128,
      temperature: 0.2,
      top_p: 0.9,
      reasoning: { effort: 'high' },
      tool_choice: 'auto',
      text: { format: { type: 'json_object' } },
      stream: true,
      group: 'vip',
    })
    expect(bodyOf(request).input).toEqual([{ role: 'user', content: 'Hi' }])
  })

  it('replays assistant tool calls as Responses function call items', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        messages: [
          { role: 'user', content: 'Find it' },
          {
            role: 'assistant',
            content: 'Looking',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'found' },
        ],
      },
      'responses'
    )

    expect(bodyOf(request).input).toEqual([
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ])
  })

  it('flattens chat tools into the Responses tool shape', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up a record',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
      'responses'
    )

    expect(bodyOf(request).tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a record',
        parameters: { type: 'object', properties: {} },
      },
    ])
  })

  it('always sends max_tokens and lifts the system prompt for Messages', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        max_tokens: 64,
        temperature: 0.3,
        frequency_penalty: 0.5,
        presence_penalty: 0.4,
        seed: 7,
        reasoning_effort: 'high',
        response_format: { type: 'json_object' },
      },
      'messages'
    )

    expect(request.endpoint).toBe('/pg/messages')
    expect(bodyOf(request)).toMatchObject({
      model: 'gpt-4o',
      system: 'Be terse.',
      max_tokens: 64,
      temperature: 0.3,
      stream: true,
      group: 'vip',
    })
    expect(bodyOf(request).messages).toEqual([{ role: 'user', content: 'Hi' }])
    // Parameters Anthropic does not accept are dropped instead of forwarded.
    expect(bodyOf(request)).not.toHaveProperty('frequency_penalty')
    expect(bodyOf(request)).not.toHaveProperty('presence_penalty')
    expect(bodyOf(request)).not.toHaveProperty('seed')
    expect(bodyOf(request)).not.toHaveProperty('reasoning_effort')
    expect(bodyOf(request)).not.toHaveProperty('response_format')
  })

  it('falls back to the composer default when max_tokens is unset', () => {
    const request = buildPlaygroundProtocolRequest(base, 'messages')

    expect(bodyOf(request).max_tokens).toBe(4096)
  })

  it('converts image parts and merges consecutive Messages turns', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        messages: [
          { role: 'system', content: 'Be terse.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AAAA' },
              },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/cat.png' },
              },
            ],
          },
          { role: 'user', content: 'Second turn' },
        ],
      },
      'messages'
    )

    expect(bodyOf(request).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/cat.png' },
          },
          { type: 'text', text: 'Second turn' },
        ],
      },
    ])
  })

  it('maps tools, tool choice and replayed tool use into the Messages shape', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        tool_choice: 'required',
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up a record',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        messages: [
          { role: 'user', content: 'Find it' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'tool_1', content: 'found' },
        ],
      },
      'messages'
    )

    expect(bodyOf(request).tools).toEqual([
      {
        name: 'lookup',
        description: 'Look up a record',
        input_schema: { type: 'object', properties: {} },
      },
    ])
    expect(bodyOf(request).tool_choice).toEqual({ type: 'any' })
    expect(bodyOf(request).messages).toEqual([
      { role: 'user', content: 'Find it' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'lookup',
            input: { q: 'x' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'found' },
        ],
      },
    ])
  })

  it('drops an empty assistant turn the Messages API would reject', () => {
    const request = buildPlaygroundProtocolRequest(
      {
        ...base,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: '' },
        ],
      },
      'messages'
    )

    expect(bodyOf(request).messages).toEqual([{ role: 'user', content: 'Hi' }])
  })
})

describe('playgroundProtocolUnsupportedFields', () => {
  it('names the fields each protocol conversion drops', () => {
    const payload: ChatCompletionRequest = {
      ...base,
      frequency_penalty: 0.5,
      presence_penalty: 0.4,
      seed: 7,
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
    }

    expect(playgroundProtocolUnsupportedFields(payload, 'chat')).toEqual([])
    expect(playgroundProtocolUnsupportedFields(payload, 'responses')).toEqual([
      'frequency_penalty',
      'presence_penalty',
      'seed',
    ])
    expect(playgroundProtocolUnsupportedFields(payload, 'messages')).toEqual([
      'frequency_penalty',
      'presence_penalty',
      'seed',
      'reasoning_effort',
      'response_format',
    ])
  })

  it('reports no field when the payload does not carry any', () => {
    expect(playgroundProtocolUnsupportedFields(base, 'messages')).toEqual([])
  })
})
