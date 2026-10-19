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
  DEFAULT_CONFIG,
  DEFAULT_PARAMETER_ENABLED,
  PLAYGROUND_DEVELOPER_ERRORS,
} from '../../../constants'
import type { Message, PlaygroundDeveloperOptions } from '../../../types'
import { buildChatCompletionPayload } from '../../streaming/payload-builder'
import {
  buildDeveloperRequestFields,
  developerOptionsActive,
  normalizeDeveloperOptions,
  serializeDeveloperOptions,
  validateDeveloperOptions,
} from '../developer-options'
import { checkJsonAgainstSchema, parseStructuredJson } from '../json-schema'

function userMessage(content: string): Message {
  return {
    key: 'm1',
    from: 'user',
    versions: [{ id: 'm1-v1', content }],
  }
}

function options(
  overrides: Partial<PlaygroundDeveloperOptions> = {}
): PlaygroundDeveloperOptions {
  return {
    enabled: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup_order',
          description: 'Look up one order.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ],
    toolChoice: 'auto',
    responseFormat: {
      type: 'json_schema',
      jsonSchema: {
        name: 'order_summary',
        schema: {
          type: 'object',
          properties: { total: { type: 'number' } },
          required: ['total'],
        },
      },
    },
    ...overrides,
  }
}

describe('developer settings storage shape', () => {
  test('legacy or unusable values degrade to the disabled defaults', () => {
    expect(normalizeDeveloperOptions(undefined)).toEqual({
      enabled: false,
      tools: [],
      toolChoice: '',
      responseFormat: { type: 'text' },
    })
    expect(
      normalizeDeveloperOptions({
        enabled: 'yes',
        tools: [
          { type: 'code_interpreter' },
          { type: 'function', function: { name: '  ' } },
        ],
        tool_choice: 'required',
        response_format: { type: 'json_schema', json_schema: { name: 'x' } },
      })
    ).toEqual({
      enabled: false,
      tools: [],
      toolChoice: '',
      responseFormat: { type: 'text' },
    })
  })

  test('a stored OpenAI wire shape reads into the camelCase local shape', () => {
    const parsed = normalizeDeveloperOptions({
      enabled: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_order',
            description: 'Look up one order.',
            parameters: { type: 'object' },
            strict: true,
          },
        },
      ],
      tool_choice: 'required',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'order_summary', schema: { type: 'object' } },
      },
    })

    expect(parsed.enabled).toBe(true)
    expect(parsed.toolChoice).toBe('required')
    expect(parsed.tools).toHaveLength(1)
    expect(parsed.tools[0].function).toEqual({
      name: 'lookup_order',
      description: 'Look up one order.',
      parameters: { type: 'object' },
      strict: true,
    })
    expect(parsed.responseFormat).toEqual({
      type: 'json_schema',
      jsonSchema: { name: 'order_summary', schema: { type: 'object' } },
    })
  })

  test('serialization writes the wire shape and keeps definitions while disabled', () => {
    expect(serializeDeveloperOptions(options({ enabled: false }))).toEqual({
      enabled: false,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_order',
            description: 'Look up one order.',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      ],
      tool_choice: 'auto',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'order_summary',
          schema: {
            type: 'object',
            properties: { total: { type: 'number' } },
            required: ['total'],
          },
        },
      },
    })
  })

  test('validation rejects duplicate tool names', () => {
    const definition = options().tools[0]

    expect(
      validateDeveloperOptions(options({ tools: [definition, definition] }))
    ).toBe(PLAYGROUND_DEVELOPER_ERRORS.DUPLICATE_NAME)
    expect(validateDeveloperOptions(options())).toBeNull()
  })

  test('the status flag only claims an effect while something is injected', () => {
    expect(developerOptionsActive(options())).toBe(true)
    expect(developerOptionsActive(options({ enabled: false }))).toBe(false)
    expect(
      developerOptionsActive(
        options({ tools: [], toolChoice: '', responseFormat: { type: 'text' } })
      )
    ).toBe(false)
  })
})

describe('request payload injection', () => {
  test('enabled settings inject tools, the tool choice and the response format', () => {
    const payload = buildChatCompletionPayload(
      [userMessage('Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      '',
      undefined,
      '',
      null,
      options()
    )

    expect(payload.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup_order',
          description: 'Look up one order.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ])
    expect(payload.tool_choice).toBe('auto')
    expect(payload.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'order_summary',
        schema: {
          type: 'object',
          properties: { total: { type: 'number' } },
          required: ['total'],
        },
      },
    })
  })

  test('disabled settings add no field, so the request matches a conversation without them', () => {
    const withoutOptions = buildChatCompletionPayload(
      [userMessage('Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED
    )
    const disabled = buildChatCompletionPayload(
      [userMessage('Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      '',
      undefined,
      '',
      null,
      options({ enabled: false })
    )

    expect(disabled).toEqual(withoutOptions)
    expect('tools' in disabled).toBe(false)
    expect('tool_choice' in disabled).toBe(false)
    expect('response_format' in disabled).toBe(false)
  })

  test('a tool choice without a defined tool is not injected', () => {
    expect(
      buildDeveloperRequestFields(
        options({ tools: [], responseFormat: { type: 'text' } })
      )
    ).toEqual({})
  })
})

describe('structured response check', () => {
  test('a fenced JSON answer is parsed before checking', () => {
    expect(parseStructuredJson('```json\n{"total": 1}\n```')).toEqual({
      ok: true,
      value: { total: 1 },
    })
    expect(parseStructuredJson('not json')).toEqual({ ok: false })
  })

  test('mismatches report the path and the failed keyword', () => {
    const result = checkJsonAgainstSchema(
      { total: '1', extra: true },
      {
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total', 'currency'],
        additionalProperties: false,
      }
    )

    expect(result.valid).toBe(false)
    expect(result.violations).toHaveLength(3)
    expect(result.violations).toEqual(
      expect.arrayContaining([
        { path: '$.total', reason: 'type', detail: 'number' },
        { path: '$', reason: 'required', detail: 'currency' },
        { path: '$', reason: 'additionalProperties', detail: 'extra' },
      ])
    )
  })

  test('a matching value passes and unsupported keywords are ignored', () => {
    expect(
      checkJsonAgainstSchema(
        { total: 1 },
        {
          type: 'object',
          properties: { total: { type: 'number' } },
          required: ['total'],
          $defs: { unused: { type: 'string' } },
        }
      )
    ).toEqual({ valid: true, violations: [] })
  })
})
