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

import { PLAYGROUND_TOOL_EXECUTION_ERRORS } from '../../../constants'
import type { Message, MessageToolCall } from '../../../types'
import type { PlaygroundMCPToolRef } from '../mcp-tools'
import {
  buildKnowledgeSearchToolResult,
  buildTimeToolResult,
  buildWebSearchToolResult,
  countToolRoundsSinceLastUser,
  getExecutableToolKind,
  getPendingExecutableToolCalls,
  getToolLoopMessage,
  parseToolArguments,
  TOOL_RESULT_TRUNCATED_MARKER,
  ToolExecutionError,
  truncateToolResultBytes,
  utf8ByteLength,
} from '../tool-execution'

function toolCall(overrides: Partial<MessageToolCall> = {}): MessageToolCall {
  return {
    id: 'call_1',
    name: 'web_search',
    arguments: '{"query":"go"}',
    status: 'pending',
    ...overrides,
  }
}

function assistantMessage(
  toolCalls: MessageToolCall[],
  overrides: Partial<Message> = {}
): Message {
  return {
    key: 'assistant-1',
    from: 'assistant',
    status: 'complete',
    versions: [{ id: 'a1', content: '', toolCalls }],
    ...overrides,
  }
}

function userMessage(key = 'user-1'): Message {
  return {
    key,
    from: 'user',
    versions: [{ id: `${key}-v1`, content: 'question' }],
  }
}

describe('executable tool matching and arguments', () => {
  test('only the declared function names match, ignoring case and spacing', () => {
    expect(getExecutableToolKind(' Web_Search ')).toBe('web_search')
    expect(getExecutableToolKind('get_time')).toBe('get_time')
    expect(getExecutableToolKind('kb_search')).toBe('kb_search')
    expect(getExecutableToolKind('open_page')).toBeNull()
  })

  test('arguments parse as a data-only JSON object', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments(' {"query":"go"} ')).toEqual({ query: 'go' })
    expect(parseToolArguments('[1]')).toBeNull()
    expect(parseToolArguments('{"query":')).toBeNull()
  })

  test('pending executable calls exclude answered and unknown calls', () => {
    const message = assistantMessage([
      toolCall({ id: 'call_web' }),
      toolCall({ id: 'call_time', name: 'get_time', status: 'completed' }),
      toolCall({ id: 'call_other', name: 'open_page' }),
    ])

    expect(
      getPendingExecutableToolCalls(message).map((call) => call.id)
    ).toEqual(['call_web'])
  })

  test('an MCP call is executable only while its connection tool is declared', () => {
    const mcpTools: PlaygroundMCPToolRef[] = [
      {
        serverId: 'github',
        serverName: 'GitHub',
        toolName: 'ping',
        functionName: 'mcp__github__ping',
      },
    ]
    const message = assistantMessage([
      toolCall({ id: 'call_mcp', name: 'mcp__github__ping' }),
      toolCall({ id: 'call_gone', name: 'mcp__github__gone' }),
    ])

    expect(
      getPendingExecutableToolCalls(message, mcpTools).map((call) => call.id)
    ).toEqual(['call_mcp'])
    expect(
      getPendingExecutableToolCalls(message).map((call) => call.id)
    ).toEqual([])
  })
})

describe('result shaping', () => {
  test('a result cut to the byte budget keeps whole characters and says so', () => {
    const value = '中'.repeat(30)
    const cut = truncateToolResultBytes(value, 60)

    expect(cut.endsWith(TOOL_RESULT_TRUNCATED_MARKER)).toBe(true)
    expect(utf8ByteLength(cut)).toBeLessThanOrEqual(60)
    expect(cut.startsWith('中'.repeat(12))).toBe(true)
    expect(truncateToolResultBytes('short', 100)).toBe('short')
  })

  test('the time result reports the requested zone in protocol JSON', () => {
    const result = JSON.parse(
      buildTimeToolResult(new Date('2026-10-19T12:34:56Z'), 'UTC')
    )

    expect(result).toMatchObject({
      iso: '2026-10-19T12:34:56.000Z',
      local: '2026-10-19 12:34:56',
      timezone: 'UTC',
      weekday: 'Monday',
      unix_seconds: Math.floor(
        new Date('2026-10-19T12:34:56Z').getTime() / 1000
      ),
    })
  })

  test('an unknown time zone is a stable execution error', () => {
    expect(() => buildTimeToolResult(new Date(), 'Not/AZone')).toThrow(
      ToolExecutionError
    )
    try {
      buildTimeToolResult(new Date(), 'Not/AZone')
    } catch (error) {
      expect((error as ToolExecutionError).message).toBe(
        PLAYGROUND_TOOL_EXECUTION_ERRORS.INVALID_TIME_ZONE
      )
    }
  })

  test('web search and knowledge hits become model-facing JSON', () => {
    const web = JSON.parse(
      buildWebSearchToolResult({
        query: 'go',
        provider: 'tavily',
        results: [{ title: 'Go', url: 'https://go.dev', snippet: 'Docs' }],
      })
    )
    expect(web.results).toEqual([
      { title: 'Go', url: 'https://go.dev', snippet: 'Docs' },
    ])

    const knowledge = JSON.parse(
      buildKnowledgeSearchToolResult('go', {
        hits: [
          {
            knowledgeBaseId: 'kb_1',
            knowledgeBaseName: 'Docs',
            documentId: 'doc_1',
            filename: 'guide.md',
            chunkId: 'chunk_1',
            chunkIndex: 2,
            score: 0.91234,
            text: 'chunk text',
          },
        ],
        staleDocuments: [
          { id: 'doc_2', filename: 'old.md', embeddingModel: 'text-embed' },
        ],
      })
    )
    expect(knowledge.results[0]).toMatchObject({
      citation: 1,
      knowledge_base: 'Docs',
      file: 'guide.md',
      score: 0.9123,
    })
    expect(knowledge.stale_documents).toEqual([
      { file: 'old.md', embedding_model: 'text-embed' },
    ])
  })
})

describe('the bounded tool loop', () => {
  test('rounds count assistant tool replies after the newest user turn', () => {
    const olderRound = assistantMessage([toolCall({ id: 'call_old' })], {
      key: 'assistant-0',
    })
    const roundOne = assistantMessage([toolCall({ id: 'call_1' })])
    const roundTwo = assistantMessage([toolCall({ id: 'call_2' })], {
      key: 'assistant-2',
    })

    expect(
      countToolRoundsSinceLastUser([
        userMessage('user-0'),
        olderRound,
        userMessage(),
        roundOne,
        roundTwo,
      ])
    ).toBe(2)
    expect(countToolRoundsSinceLastUser([userMessage(), roundOne])).toBe(1)
  })

  test('only the latest settled tool reply starts the loop', () => {
    const settled = assistantMessage([toolCall()])
    expect(getToolLoopMessage([userMessage(), settled])).toBe(settled)
    expect(getToolLoopMessage([userMessage(), assistantMessage([])])).toBeNull()
    expect(
      getToolLoopMessage([
        userMessage(),
        assistantMessage([toolCall()], { status: 'streaming' }),
      ])
    ).toBeNull()
    expect(
      getToolLoopMessage([userMessage(), userMessage('user-2')])
    ).toBeNull()
  })
})
