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
  getReasoningEffortLabelKey,
  modelSupportsReasoningEffort,
  normalizeReasoningEffort,
  PLAYGROUND_REASONING_EFFORT_VALUES,
} from '../parameters/playground-reasoning'

describe('reasoning effort model gate', () => {
  test('offers the control for the model families that accept an effort', () => {
    for (const model of [
      'gpt-5',
      'gpt-5.1-mini',
      'openai/gpt-5',
      'gpt-oss-120b',
      'o3-mini',
      'claude-sonnet-4-5',
      'claude-opus-4-6',
      'claude-3-7-sonnet',
      'gemini-2.5-pro',
      'gemini-3-pro-preview',
      'deepseek-reasoner',
      'deepseek-v4',
      'kimi-k2-thinking',
      'glm-4.6',
      'qwen3-235b',
      'grok-4',
      'magistral-medium',
    ]) {
      expect(modelSupportsReasoningEffort(model), model).toBe(true)
    }
  })

  test('hides the control for models without an effort control', () => {
    for (const model of [
      '',
      '   ',
      'gpt-4o',
      'gpt-4.1',
      'claude-3-5-sonnet',
      'gemini-1.5-pro',
      'deepseek-chat',
      'llama-3.3-70b',
      'grok-2',
    ]) {
      expect(modelSupportsReasoningEffort(model), model).toBe(false)
    }
  })
})

describe('reasoning effort normalization', () => {
  test('keeps every effort the relay accepts', () => {
    for (const effort of PLAYGROUND_REASONING_EFFORT_VALUES) {
      expect(normalizeReasoningEffort(effort)).toBe(effort)
      expect(getReasoningEffortLabelKey(effort)).not.toBeNull()
    }
  })

  test('trims and lowercases before matching', () => {
    expect(normalizeReasoningEffort('  HIGH ')).toBe('high')
  })

  test('an unknown or absent effort becomes empty and has no label', () => {
    for (const value of ['turbo', '', null, undefined, 3, {}]) {
      expect(normalizeReasoningEffort(value)).toBe('')
      expect(getReasoningEffortLabelKey(value)).toBeNull()
    }
  })
})
