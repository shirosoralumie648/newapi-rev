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
  ERROR_MESSAGES,
  MESSAGE_STATUS,
  PLAYGROUND_PARALLEL_MAX_MODELS,
} from '../../../constants'
import type { Message } from '../../../types'
import {
  anonymizeParallelMessage,
  anonymousParallelModelLabel,
  appendParallelMessagePair,
  applyParallelCompletionChoice,
  applyParallelVersionError,
  createParallelReplyMessage,
  getParallelPromptMessages,
  interruptParallelMessage,
  isAnonymousParallelMessage,
  isParallelMessage,
  isPendingParallelVersion,
  normalizeParallelModels,
  redactAnonymousParallelContent,
  settleParallelMessage,
  startParallelVersionRetry,
} from '../parallel-compare-utils'

function choice(content: string) {
  return {
    index: 0,
    message: { role: 'assistant' as const, content },
    finish_reason: 'stop',
  }
}

function comparisonGroup(models: string[] = ['gpt-4o', 'claude-3']): Message {
  return createParallelReplyMessage(models, 100)
}

describe('the models one comparison may hold', () => {
  test('trims, deduplicates and bounds the selection', () => {
    expect(
      normalizeParallelModels([' gpt-4o ', 'gpt-4o', '', 'claude-3'])
    ).toEqual(['gpt-4o', 'claude-3'])

    const many = Array.from({ length: 6 }, (_, index) => `model-${index}`)
    expect(normalizeParallelModels(many)).toHaveLength(
      PLAYGROUND_PARALLEL_MAX_MODELS
    )
  })

  test('creates one pending labelled version per selected model', () => {
    const group = comparisonGroup()

    expect(isParallelMessage(group)).toBe(true)
    expect(group.status).toBe(MESSAGE_STATUS.LOADING)
    expect(
      group.versions.map((version) => [version.model, version.status])
    ).toEqual([
      ['gpt-4o', MESSAGE_STATUS.LOADING],
      ['claude-3', MESSAGE_STATUS.LOADING],
    ])
  })

  test('appends the user turn and the group, and the prompt slice keeps both', () => {
    const messages = appendParallelMessagePair(
      [],
      'Compare this',
      undefined,
      ['gpt-4o', 'claude-3'],
      200
    )

    expect(messages).toHaveLength(2)
    expect(messages[0].from).toBe('user')
    expect(messages[0].versions[0].content).toBe('Compare this')
    expect(messages[1].parallel).toBe(true)
    expect(messages[1].versions).toHaveLength(2)
    expect(getParallelPromptMessages(messages, messages[1].key)).toEqual([
      messages[0],
    ])
  })
})

describe('settling one comparison', () => {
  test('stays loading while any compared reply is pending', () => {
    const group = applyParallelCompletionChoice(
      comparisonGroup(),
      0,
      choice('Answer A'),
      { requestId: 'req-a' }
    )

    const settled = settleParallelMessage(group, 300)

    expect(settled.status).toBe(MESSAGE_STATUS.LOADING)
    expect(settled.completedAt).toBeUndefined()
    expect(settled.versions[0].content).toBe('Answer A')
    expect(isPendingParallelVersion(settled.versions[1])).toBe(true)
  })

  test('completes once every compared reply arrived', () => {
    let group = applyParallelCompletionChoice(
      comparisonGroup(),
      0,
      choice('Answer A'),
      { requestId: 'req-a' }
    )
    group = applyParallelCompletionChoice(group, 1, choice('Answer B'), {
      requestId: 'req-b',
    })

    expect(group.status).toBe(MESSAGE_STATUS.COMPLETE)
    expect(group.completedAt).toBeTypeOf('number')
    expect(group.versions.map((version) => version.content)).toEqual([
      'Answer A',
      'Answer B',
    ])
    expect(group.versions[1].model).toBe('claude-3')
  })

  test('fails only when every compared reply failed', () => {
    let group = applyParallelVersionError(
      comparisonGroup(),
      0,
      'Upstream refused'
    )
    expect(group.status).toBe(MESSAGE_STATUS.LOADING)

    group = applyParallelVersionError(group, 1, 'Gateway timeout')
    expect(group.status).toBe(MESSAGE_STATUS.ERROR)
  })

  test('falls back to a completed reply when the active reply failed', () => {
    let group = applyParallelCompletionChoice(
      comparisonGroup(),
      1,
      choice('Answer B')
    )
    group = applyParallelVersionError(group, 0, 'Upstream refused')

    expect(group.status).toBe(MESSAGE_STATUS.COMPLETE)
    expect(group.activeVersionIndex).toBe(1)
  })
})

describe('one compared reply at a time', () => {
  test('stores a reply on its own version with the model label and request id', () => {
    const updated = applyParallelCompletionChoice(
      comparisonGroup(),
      1,
      choice('Answer B'),
      {
        requestId: 'req-b',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      }
    )

    expect(updated.versions[0].content).toBe('')
    expect(updated.versions[1]).toMatchObject({
      model: 'claude-3',
      content: 'Answer B',
      status: MESSAGE_STATUS.COMPLETE,
      requestId: 'req-b',
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    })
    expect(updated.versions[1].errorCode).toBeNull()
  })

  test('stores a failure on its version and keeps the billed request id', () => {
    const updated = applyParallelVersionError(
      comparisonGroup(),
      0,
      'Upstream refused',
      'UPSTREAM_ERROR',
      { requestId: 'req-a' }
    )

    expect(updated.versions[0]).toMatchObject({
      status: MESSAGE_STATUS.ERROR,
      errorCode: 'UPSTREAM_ERROR',
      requestId: 'req-a',
    })
    expect(updated.versions[0].content).toContain('Upstream refused')
    expect(isPendingParallelVersion(updated.versions[1])).toBe(true)
  })

  test('a retry returns the failed reply to its pending state', () => {
    let group = applyParallelVersionError(
      comparisonGroup(),
      0,
      'Upstream refused',
      'UPSTREAM_ERROR'
    )
    group = startParallelVersionRetry(group, 0)

    expect(isPendingParallelVersion(group.versions[0])).toBe(true)
    expect(group.versions[0]).toMatchObject({ content: '', errorCode: null })
    expect(group.versions[0].requestId).toBeUndefined()
  })

  test('interrupting settles only the replies that never arrived', () => {
    const group = applyParallelCompletionChoice(
      comparisonGroup(),
      0,
      choice('Answer A')
    )

    const interrupted = interruptParallelMessage(group, 400)

    expect(interrupted.versions[0]).toMatchObject({
      status: MESSAGE_STATUS.COMPLETE,
      content: 'Answer A',
    })
    expect(interrupted.versions[1].status).toBe(MESSAGE_STATUS.ERROR)
    expect(interrupted.versions[1].content).toContain(
      ERROR_MESSAGES.INTERRUPTED
    )
    expect(interrupted.status).toBe(MESSAGE_STATUS.COMPLETE)
  })
})

describe('anonymous A/B arena groups', () => {
  test('only an exact two-model comparison is anonymous', () => {
    expect(
      isAnonymousParallelMessage(
        createParallelReplyMessage(['gpt-4o', 'claude-3'], 100, undefined, true)
      )
    ).toBe(true)
    expect(
      isAnonymousParallelMessage(
        createParallelReplyMessage(['gpt-4o', 'claude-3'], 100)
      )
    ).toBe(false)

    const three = createParallelReplyMessage(
      ['gpt-4o', 'claude-3', 'gemini-pro'],
      100,
      undefined,
      true
    )
    expect(three.anonymous).toBeUndefined()
    expect(isAnonymousParallelMessage(three)).toBe(false)
  })

  test('stable labels replace the compared model names', () => {
    expect(anonymousParallelModelLabel(0)).toBe('Model A')
    expect(anonymousParallelModelLabel(1)).toBe('Model B')
    expect(anonymousParallelModelLabel(7)).toBe('Model B')
  })

  test('render copy removes names from replies and reasoning, longest name first', () => {
    const group = createParallelReplyMessage(
      ['gpt-4o', 'gpt-4'],
      100,
      undefined,
      true
    )
    group.versions[0].content = 'GPT-4O answered first.'
    group.versions[1].content = 'gpt-4 failed with gpt-4o visible.'
    group.reasoning = {
      content: 'Comparing gpt-4 and gpt-4o.',
      duration: 12,
    }

    const safe = anonymizeParallelMessage(group)

    expect(safe).not.toBe(group)
    expect(safe.versions[0].model).toBeUndefined()
    expect(safe.versions[1].model).toBeUndefined()
    expect(safe.versions[0].content).toBe('Model A answered first.')
    expect(safe.versions[1].content).toBe(
      'Model B failed with Model A visible.'
    )
    expect(safe.reasoning?.content).toBe('Comparing Model B and Model A.')
    // The original message keeps the real models for retry and continuation.
    expect(group.versions[0].model).toBe('gpt-4o')
    expect(group.versions[1].model).toBe('gpt-4')
  })

  test('ordinary comparisons are returned unchanged', () => {
    const group = comparisonGroup()
    expect(anonymizeParallelMessage(group)).toBe(group)
  })

  test('redaction leaves text untouched without a model name', () => {
    expect(redactAnonymousParallelContent('Plain reply.', ['gpt-4o', ''])).toBe(
      'Plain reply.'
    )
  })
})
