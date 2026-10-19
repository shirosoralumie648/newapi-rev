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

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import type { AssistantPreset, Message } from '../../types'
import {
  presetAvatarUrl,
  presetInputFromSettings,
  presetSessionSettings,
} from '../preset/preset-utils'
import { buildChatCompletionPayload } from '../streaming/payload-builder'

function userMessage(content: string): Message {
  return {
    key: 'm1',
    from: 'user',
    versions: [{ id: 'm1-v1', content }],
  }
}

function preset(overrides: Partial<AssistantPreset> = {}): AssistantPreset {
  return {
    id: 'pgp_1',
    name: 'Reviewer',
    avatar: '🧑‍💻',
    config: {
      ...DEFAULT_CONFIG,
      model: 'preset-model',
      temperature: 0.2,
      max_tokens: 1024,
    },
    parameterEnabled: { ...DEFAULT_PARAMETER_ENABLED, max_tokens: true },
    systemPrompt: 'Review code carefully.',
    visibility: 'private',
    openingMessage: 'Welcome to the review.',
    suggestedQuestions: ['Explain the diff', 'Find bugs'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('system prompt injection', () => {
  test('a conversation prompt becomes the first system message', () => {
    const payload = buildChatCompletionPayload(
      [userMessage('Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      '  Answer in French.  '
    )

    expect(payload.messages).toEqual([
      { role: 'system', content: 'Answer in French.' },
      { role: 'user', content: 'Hello' },
    ])
  })

  test('an empty or whitespace-only prompt adds no message', () => {
    const base = buildChatCompletionPayload(
      [userMessage('Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED
    )
    const blank = buildChatCompletionPayload(
      [userMessage('Hello')],
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      '   \n  '
    )

    expect(base.messages).toEqual([{ role: 'user', content: 'Hello' }])
    expect(blank.messages).toEqual(base.messages)
  })
})

describe('assistant preset settings', () => {
  test('applying a preset keeps routing and copies model, parameters and prompt', () => {
    const settings = presetSessionSettings(preset(), {
      config: { ...DEFAULT_CONFIG, group: 'vip', stream: false },
      parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    })

    expect(settings.config).toEqual({
      ...DEFAULT_CONFIG,
      group: 'vip',
      stream: false,
      model: 'preset-model',
      temperature: 0.2,
      max_tokens: 1024,
    })
    expect(settings.parameterEnabled).toEqual({
      ...DEFAULT_PARAMETER_ENABLED,
      max_tokens: true,
    })
    expect(settings.systemPrompt).toBe('Review code carefully.')
    expect(settings.openingMessage).toBe('Welcome to the review.')
    expect(settings.suggestedQuestions).toEqual([
      'Explain the diff',
      'Find bugs',
    ])
  })

  test('a preset without a model keeps the conversation model', () => {
    const settings = presetSessionSettings(
      preset({ config: { ...DEFAULT_CONFIG, model: '' } }),
      {
        config: { ...DEFAULT_CONFIG, model: 'current-model' },
        parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      }
    )

    expect(settings.config.model).toBe('current-model')
  })

  test('building a preset payload drops routing, transport and surrounding space', () => {
    const input = presetInputFromSettings('  Reviewer  ', ' 🧑‍💻 ', {
      config: { ...DEFAULT_CONFIG, group: 'vip', stream: false, model: 'm' },
      parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      systemPrompt: 'Review code carefully.',
      openingMessage: 'Welcome to the review.',
      suggestedQuestions: ['Explain the diff'],
    })

    expect(input.name).toBe('Reviewer')
    expect(input.avatar).toBe('🧑‍💻')
    expect(input.config).not.toHaveProperty('group')
    expect(input.config).not.toHaveProperty('stream')
    expect(input.config.model).toBe('m')
    expect(input.parameter_enabled).toEqual(DEFAULT_PARAMETER_ENABLED)
    expect(input.system_prompt).toBe('Review code carefully.')
    expect(input.opening_message).toBe('Welcome to the review.')
    expect(input.suggested_questions).toEqual(['Explain the diff'])
  })
})

describe('reasoning effort copy and payload', () => {
  test('applying a preset copies its reasoning effort and enabled state', () => {
    const settings = presetSessionSettings(
      preset({
        config: { ...DEFAULT_CONFIG, reasoning_effort: 'high' },
        parameterEnabled: {
          ...DEFAULT_PARAMETER_ENABLED,
          reasoning_effort: true,
        },
      }),
      {
        config: DEFAULT_CONFIG,
        parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      }
    )

    expect(settings.config.reasoning_effort).toBe('high')
    expect(settings.parameterEnabled.reasoning_effort).toBe(true)
  })

  test('building a preset payload copies the reasoning effort', () => {
    const input = presetInputFromSettings('Reviewer', '', {
      config: { ...DEFAULT_CONFIG, reasoning_effort: 'minimal' },
      parameterEnabled: {
        ...DEFAULT_PARAMETER_ENABLED,
        reasoning_effort: true,
      },
      systemPrompt: '',
      openingMessage: '',
      suggestedQuestions: [],
    })

    expect(input.config.reasoning_effort).toBe('minimal')
    expect(input.parameter_enabled?.reasoning_effort).toBe(true)
  })

  test('the request carries the effort only while enabled and accepted', () => {
    const enabled = buildChatCompletionPayload(
      [userMessage('Hello')],
      { ...DEFAULT_CONFIG, model: 'gpt-5', reasoning_effort: 'xhigh' },
      { ...DEFAULT_PARAMETER_ENABLED, reasoning_effort: true }
    )
    expect(enabled.reasoning_effort).toBe('xhigh')

    const disabled = buildChatCompletionPayload(
      [userMessage('Hello')],
      { ...DEFAULT_CONFIG, model: 'gpt-5', reasoning_effort: 'xhigh' },
      DEFAULT_PARAMETER_ENABLED
    )
    expect(disabled).not.toHaveProperty('reasoning_effort')

    const invalid = buildChatCompletionPayload(
      [userMessage('Hello')],
      { ...DEFAULT_CONFIG, model: 'gpt-5', reasoning_effort: 'turbo' },
      { ...DEFAULT_PARAMETER_ENABLED, reasoning_effort: true }
    )
    expect(invalid).not.toHaveProperty('reasoning_effort')

    const unset = buildChatCompletionPayload(
      [userMessage('Hello')],
      { ...DEFAULT_CONFIG, model: 'gpt-5' },
      { ...DEFAULT_PARAMETER_ENABLED, reasoning_effort: true }
    )
    expect(unset).not.toHaveProperty('reasoning_effort')

    // The control is hidden for a model that does not accept an effort, so a
    // stale enabled flag never sends the parameter upstream.
    const unsupported = buildChatCompletionPayload(
      [userMessage('Hello')],
      { ...DEFAULT_CONFIG, reasoning_effort: 'xhigh' },
      { ...DEFAULT_PARAMETER_ENABLED, reasoning_effort: true }
    )
    expect(unsupported).not.toHaveProperty('reasoning_effort')
  })
})

describe('preset avatar rendering', () => {
  test('only http(s) URLs are treated as image sources', () => {
    expect(presetAvatarUrl('https://example.com/a.png')).toBe(
      'https://example.com/a.png'
    )
    expect(presetAvatarUrl('🧑‍💻')).toBeNull()
    expect(presetAvatarUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(presetAvatarUrl('javascript:alert(1)')).toBeNull()
  })
})
