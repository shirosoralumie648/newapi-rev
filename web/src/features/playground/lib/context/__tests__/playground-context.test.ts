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
import { afterEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_CONTEXT_SETTINGS,
  HISTORY_IMAGE_OMITTED_CONTENT,
  PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX,
  PLAYGROUND_CONTEXT_IMAGE_TOKEN_ESTIMATE,
  PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX,
  PLAYGROUND_SUMMARY_INPUT_MAX_CHARS,
} from '../../../constants'
import type {
  Message,
  MessageKnowledgeSnapshot,
  PlaygroundContextSettings,
  PlaygroundContextSummary,
} from '../../../types'
import {
  clearPlaygroundAttachmentCache,
  primePlaygroundAttachment,
} from '../../attachment-store'
import { formatMessageKnowledgeContext } from '../../message/message-utils'
import {
  buildContextSummaryRequest,
  estimateMessageTokens,
  estimateTextTokens,
  formatMessageForRequest,
  normalizeContextSettings,
  normalizeContextSummary,
  planPlaygroundContext,
} from '../playground-context'

function message(
  key: string,
  content: string,
  from: 'user' | 'assistant' = 'user'
): Message {
  return { key, from, versions: [{ id: `${key}-v1`, content }] }
}

function settings(
  overrides: Partial<PlaygroundContextSettings> = {}
): PlaygroundContextSettings {
  return { ...DEFAULT_CONTEXT_SETTINGS, ...overrides }
}

function summary(
  overrides: Partial<PlaygroundContextSummary> = {}
): PlaygroundContextSummary {
  return {
    id: 'pgc_1',
    content: 'Earlier messages were compressed.',
    throughMessageKey: 'm2',
    messageCount: 2,
    model: 'summary-model',
    createdAt: 1,
    ...overrides,
  }
}

afterEach(() => {
  clearPlaygroundAttachmentCache()
})

describe('token estimation', () => {
  test('ascii counts by characters and non-ascii per code point', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcde')).toBe(2)
    expect(estimateTextTokens('你好')).toBe(2)
    expect(estimateTextTokens('你好 ab')).toBe(3)
  })

  test('an image adds a fixed allowance and tool call arguments are counted', () => {
    // Both messages carry the same text, so their difference is exactly the
    // image allowance.
    const plain = message('m1', 'look')
    const withImage: Message = {
      key: 'm2',
      from: 'user',
      versions: [
        {
          id: 'v',
          content: 'look',
          attachments: [{ id: 'a1', url: '', mediaType: 'image/png' }],
        },
      ],
    }
    expect(
      estimateMessageTokens(withImage) - estimateMessageTokens(plain)
    ).toBe(PLAYGROUND_CONTEXT_IMAGE_TOKEN_ESTIMATE)

    const completedCall = {
      id: 'c1',
      name: 'search',
      arguments: 'a'.repeat(400),
      status: 'completed' as const,
    }
    const withCall: Message = {
      key: 'm3',
      from: 'assistant',
      versions: [
        {
          id: 'v',
          content: '',
          toolCalls: [completedCall],
        },
      ],
    }
    expect(estimateMessageTokens(withCall)).toBeGreaterThanOrEqual(100)

    // An answered call also sends its result, so the result text must count.
    const withResult: Message = {
      ...withCall,
      versions: [
        {
          ...withCall.versions[0],
          toolCalls: [{ ...completedCall, result: 'x'.repeat(4000) }],
        },
      ],
    }
    expect(estimateMessageTokens(withResult)).toBeGreaterThanOrEqual(
      estimateMessageTokens(withCall) + 1000
    )
  })
})

describe('normalization', () => {
  test('out-of-range context settings clamp instead of reaching the planner', () => {
    expect(normalizeContextSettings(undefined)).toEqual(
      DEFAULT_CONTEXT_SETTINGS
    )
    expect(
      normalizeContextSettings({
        historyLimit: -3,
        tokenBudget: 12.5,
        autoSummarize: 'yes',
        summaryModel: 'summary-model',
      })
    ).toEqual({
      historyLimit: 0,
      tokenBudget: 12,
      autoSummarize: false,
      summaryModel: 'summary-model',
    })
    expect(
      normalizeContextSettings({ historyLimit: 10_000, tokenBudget: 9_999_999 })
    ).toEqual({
      historyLimit: PLAYGROUND_CONTEXT_HISTORY_LIMIT_MAX,
      tokenBudget: PLAYGROUND_CONTEXT_TOKEN_BUDGET_MAX,
      autoSummarize: false,
      summaryModel: '',
    })
  })

  test('an incomplete compression node is rejected and unusable metadata is dropped', () => {
    expect(normalizeContextSummary(null)).toBeNull()
    expect(
      normalizeContextSummary({
        id: 'pgc',
        content: '  ',
        throughMessageKey: 'm1',
      })
    ).toBeNull()
    expect(
      normalizeContextSummary({ id: '', content: 'x', throughMessageKey: 'm1' })
    ).toBeNull()
    expect(
      normalizeContextSummary({
        id: 'pgc',
        content: 'x',
        throughMessageKey: '',
      })
    ).toBeNull()

    const normalized = normalizeContextSummary({
      id: 'pgc',
      content: 'x',
      throughMessageKey: 'm1',
      messageCount: 2.9,
      model: 'summary-model',
      createdAt: 5,
      // An over-long request id can never be looked up, so it is dropped.
      requestId: 'r'.repeat(80),
      // Incomplete usage must not become a partial token count.
      usage: { promptTokens: 1, completionTokens: -1, totalTokens: 0 },
    })
    expect(normalized).toMatchObject({
      id: 'pgc',
      throughMessageKey: 'm1',
      messageCount: 2,
      model: 'summary-model',
      createdAt: 5,
    })
    expect(normalized?.requestId).toBeUndefined()
    expect(normalized?.usage).toBeUndefined()
  })
})

describe('context planning', () => {
  test('without limits the plan sends every valid message and reports no drops', () => {
    const messages = [
      message('m1', 'first'),
      message('m2', 'second', 'assistant'),
      {
        key: 'm3',
        from: 'assistant' as const,
        versions: [{ id: 'v', content: '' }],
        status: 'loading' as const,
      },
    ]
    const plan = planPlaygroundContext({
      messages,
      settings: settings(),
      systemPrompt: 'Be brief.',
    })
    expect(plan.includedMessages.map((item) => item.key)).toEqual(['m1', 'm2'])
    expect(plan.droppedMessages).toEqual([])
    expect(plan.summaryUsed).toBeNull()
    expect(plan.hasLimits).toBe(false)
    expect(plan.exceedsLimits).toBe(false)
    expect(plan.needsSummary).toBe(false)
    expect(plan.estimatedTokens).toBeGreaterThanOrEqual(
      estimateTextTokens('Be brief.')
    )
    expect(plan.requestMessages[0]).toMatchObject({
      role: 'user',
      content: 'first',
    })
  })

  test('the history limit drops the oldest messages and a full boundary keeps all of them', () => {
    const messages = ['m1', 'm2', 'm3', 'm4'].map((key) => message(key, key))
    const exact = planPlaygroundContext({
      messages: messages.slice(0, 3),
      settings: settings({ historyLimit: 3 }),
    })
    expect(exact.droppedMessages).toEqual([])
    expect(exact.needsSummary).toBe(false)

    const over = planPlaygroundContext({
      messages,
      settings: settings({ historyLimit: 3 }),
    })
    expect(over.includedMessages.map((item) => item.key)).toEqual([
      'm2',
      'm3',
      'm4',
    ])
    expect(over.droppedMessages.map((item) => item.key)).toEqual(['m1'])
    expect(over.droppedTokens).toBe(estimateMessageTokens(messages[0]))
    expect(over.needsSummary).toBe(true)
  })

  test('the token budget keeps the newest messages and always keeps the last one', () => {
    const messages = [
      message('m1', 'x'.repeat(400)),
      message('m2', 'y'.repeat(400)),
      message('m3', 'z'.repeat(40)),
    ]
    const tight = planPlaygroundContext({
      messages,
      settings: settings({ tokenBudget: 60 }),
    })
    expect(tight.includedMessages.map((item) => item.key)).toEqual(['m3'])
    expect(tight.droppedTokens).toBe(
      estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[1])
    )

    const roomy = planPlaygroundContext({
      messages,
      settings: settings({ tokenBudget: 150 }),
    })
    expect(roomy.includedMessages.map((item) => item.key)).toEqual(['m2', 'm3'])

    // Even a budget smaller than the last message keeps that message, so the
    // send never degrades into an empty request.
    const tiny = planPlaygroundContext({
      messages,
      settings: settings({ tokenBudget: 5 }),
    })
    expect(tiny.includedMessages.map((item) => item.key)).toEqual(['m3'])
  })

  test('the memory block counts toward the token budget and the estimate', () => {
    const messages = [
      message('m1', 'x'.repeat(400)),
      message('m2', 'y'.repeat(400)),
    ]
    const memoryBlock = 'm'.repeat(40)

    const withoutMemory = planPlaygroundContext({
      messages,
      settings: settings({ tokenBudget: 205 }),
    })
    expect(withoutMemory.includedMessages.map((item) => item.key)).toEqual([
      'm1',
      'm2',
    ])

    const withMemory = planPlaygroundContext({
      messages,
      settings: settings({ tokenBudget: 205 }),
      memoryBlock,
    })
    expect(withMemory.includedMessages.map((item) => item.key)).toEqual(['m2'])
    expect(withMemory.estimatedTokens).toBeGreaterThanOrEqual(
      estimateTextTokens(memoryBlock)
    )

    expect(
      planPlaygroundContext({
        messages: [],
        settings: settings(),
        memoryBlock,
      }).estimatedTokens
    ).toBe(estimateTextTokens(memoryBlock))
  })

  test('a text-only model replaces earlier images and reports them', () => {
    // A send caches the attachment bytes before the plan is built
    // (ensurePlaygroundMessageAttachments), so the request carries the image
    // part the policy then has to replace.
    primePlaygroundAttachment('a1', 'data:image/png;base64,iVBORw0KGgo=')
    const messages: Message[] = [
      {
        key: 'm1',
        from: 'user',
        versions: [
          {
            id: 'v1',
            content: 'look',
            attachments: [{ id: 'a1', url: '', mediaType: 'image/png' }],
          },
        ],
      },
      message('m2', 'next', 'user'),
    ]
    const plan = planPlaygroundContext({
      messages,
      settings: settings(),
      model: 'deepseek-chat',
    })

    expect(plan.omittedImages).toBe(1)
    expect(plan.requestMessages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: HISTORY_IMAGE_OMITTED_CONTENT },
    ])
  })

  test('a compression node replaces the covered prefix and its text counts toward the budget', () => {
    const messages = ['m1', 'm2', 'm3', 'm4'].map((key) => message(key, key))
    const node = summary()
    const plan = planPlaygroundContext({
      messages,
      settings: settings({ historyLimit: 2 }),
      summary: node,
    })
    expect(plan.compressedMessages.map((item) => item.key)).toEqual([
      'm1',
      'm2',
    ])
    expect(plan.includedMessages.map((item) => item.key)).toEqual(['m3', 'm4'])
    expect(plan.droppedMessages).toEqual([])
    expect(plan.needsSummary).toBe(false)
    expect(plan.summaryUsed?.id).toBe('pgc_1')
    expect(plan.exceedsLimits).toBe(true)
    expect(plan.requestMessages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Earlier messages were compressed.'),
    })

    // The summary text is part of what the model receives, so it consumes the
    // budget: the same settings fit one more message without it.
    const long = ['m1', 'm2', 'm3', 'm4'].map((key) =>
      message(key, 'x'.repeat(400))
    )
    const summaryText = 'x'.repeat(12)
    const withSummary = planPlaygroundContext({
      messages: long,
      settings: settings({ tokenBudget: 302 }),
      summary: summary({ content: summaryText, throughMessageKey: 'm1' }),
    })
    expect(withSummary.includedMessages.map((item) => item.key)).toEqual([
      'm3',
      'm4',
    ])
    const withoutSummary = planPlaygroundContext({
      messages: long,
      settings: settings({ tokenBudget: 302 }),
    })
    expect(withoutSummary.includedMessages.map((item) => item.key)).toEqual([
      'm2',
      'm3',
      'm4',
    ])
  })

  test('a compression node whose coverage marker is gone is ignored', () => {
    const messages = ['m1', 'm2'].map((key) => message(key, key))
    const plan = planPlaygroundContext({
      messages,
      settings: settings({ tokenBudget: 1 }),
      summary: summary({ throughMessageKey: 'deleted' }),
    })
    expect(plan.summaryUsed).toBeNull()
    expect(plan.compressedMessages).toEqual([])
    expect(plan.includedMessages.map((item) => item.key)).toEqual(['m2'])
  })

  test('a searched turn replays its stored hits as untrusted numbered context', () => {
    const searched: Message = {
      ...message('m1', 'What changed in Go?'),
      search: {
        query: 'latest go release',
        provider: 'tavily',
        results: [
          {
            title: 'Go releases',
            url: 'https://go.dev/blog',
            snippet: 'The latest release notes.',
          },
        ],
      },
    }

    const formatted = formatMessageForRequest(searched)
    expect(formatted).toHaveLength(1)
    expect(formatted[0].content).toContain(
      'Web search results for "latest go release".'
    )
    expect(formatted[0].content).toContain(
      '[1](https://go.dev/blog) The latest release notes.'
    )
    expect(estimateMessageTokens(searched)).toBeGreaterThan(
      estimateMessageTokens(message('m1', 'What changed in Go?'))
    )
  })

  test('a retrieved turn replays its stored knowledge hits as numbered context', () => {
    const knowledge: MessageKnowledgeSnapshot = {
      query: 'where is the handbook?',
      results: [
        {
          knowledgeBaseId: 'kb-1',
          knowledgeBaseName: 'Handbook',
          documentId: 'doc-1',
          filename: 'handbook.txt',
          chunkId: 'chunk-1',
          chunkIndex: 0,
          score: 0.875,
          text: 'The handbook lives in the shared drive.',
        },
      ],
    }
    const retrieved: Message = {
      ...message('m1', 'Where is the handbook?'),
      knowledge,
    }

    const formatted = formatMessageForRequest(retrieved)
    expect(formatted).toHaveLength(1)
    expect(formatted[0].content).toContain(
      'Knowledge base results for "where is the handbook?".'
    )
    expect(formatted[0].content).toContain(
      '[1] handbook.txt (Handbook)\nThe handbook lives in the shared drive.'
    )
    expect(
      estimateMessageTokens(retrieved) -
        estimateMessageTokens(message('m1', 'Where is the handbook?'))
    ).toBe(estimateTextTokens(formatMessageKnowledgeContext(knowledge)))
  })

  test('answered tool calls expand into tool messages while pending calls stay out', () => {
    const answered: Message = {
      key: 'a1',
      from: 'assistant',
      versions: [
        {
          id: 'v',
          content: 'Checking',
          toolCalls: [
            {
              id: 'c1',
              name: 'search',
              arguments: '{}',
              status: 'completed',
              result: 'ok',
            },
          ],
        },
      ],
    }
    const expanded = formatMessageForRequest(answered)
    expect(expanded).toHaveLength(2)
    expect(expanded[0].tool_calls?.[0].id).toBe('c1')
    expect(expanded[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })

    const pending: Message = {
      key: 'a2',
      from: 'assistant',
      versions: [
        {
          id: 'v',
          content: 'Checking',
          toolCalls: [
            { id: 'c2', name: 'search', arguments: '{}', status: 'pending' },
          ],
        },
      ],
    }
    expect(formatMessageForRequest(pending)).toHaveLength(1)
    expect(formatMessageForRequest(pending)[0].tool_calls).toBeUndefined()
  })
})

describe('summarization request', () => {
  test('is a non-streaming call that carries the previous summary and drops images', () => {
    const messages = [
      message('m1', 'first'),
      {
        key: 'm2',
        from: 'user' as const,
        versions: [
          {
            id: 'v',
            content: 'with image',
            attachments: [{ id: 'a', url: '', mediaType: 'image/png' }],
          },
        ],
      },
    ]
    const request = buildContextSummaryRequest({
      messages,
      previousSummary: summary({ content: 'Older summary.' }),
      model: 'summary-model',
      group: 'default',
    })
    expect(request.stream).toBe(false)
    expect(request.model).toBe('summary-model')
    expect(request.group).toBe('default')
    expect(request.messages[0]).toMatchObject({ role: 'system' })
    expect(request.messages[1].content).toContain('Older summary.')
    expect(request.messages[2]).toMatchObject({
      role: 'user',
      content: 'first',
    })
    expect(request.messages[3].content).toBe('with image')
    expect(JSON.stringify(request.messages)).not.toContain('image_url')
  })

  test('annotates tool calls and keeps the newest input within the bound', () => {
    const withCall: Message = {
      key: 'a1',
      from: 'assistant',
      versions: [
        {
          id: 'v',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'search', arguments: '{}', status: 'completed' },
          ],
        },
      ],
    }
    const annotated = buildContextSummaryRequest({
      messages: [withCall],
      model: 'summary-model',
      group: 'default',
    })
    expect(annotated.messages[1].content).toBe('[requested tool calls: search]')

    const huge = message('m1', 'x'.repeat(PLAYGROUND_SUMMARY_INPUT_MAX_CHARS))
    const bounded = buildContextSummaryRequest({
      messages: [huge, message('m2', 'newest')],
      model: 'summary-model',
      group: 'default',
    })
    const contents = bounded.messages
      .slice(1)
      .map((item) => item.content as string)
    expect(contents.at(-1)).toBe('newest')
    expect(contents.join('')).toHaveLength(PLAYGROUND_SUMMARY_INPUT_MAX_CHARS)
  })
})
