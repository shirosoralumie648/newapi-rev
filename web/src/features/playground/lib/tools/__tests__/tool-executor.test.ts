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
import { beforeEach, expect, test, vi } from 'vitest'

import { callPlaygroundMCPTool } from '../../../api'
import { PLAYGROUND_TOOL_EXECUTION_ERRORS } from '../../../constants'
import type { MessageToolCall } from '../../../types'
import type { PlaygroundMCPToolRef } from '../mcp-tools'
import {
  executeSupportedToolCall,
  type ToolExecutionScope,
} from '../tool-executor'

vi.mock('../../../api', () => ({
  callPlaygroundMCPTool: vi.fn(),
  searchPlaygroundWeb: vi.fn(),
}))

const mcpTool: PlaygroundMCPToolRef = {
  serverId: 'github',
  serverName: 'GitHub',
  toolName: 'ping',
  functionName: 'mcp__github__ping',
}

function scope(
  overrides: Partial<ToolExecutionScope> = {}
): ToolExecutionScope {
  return {
    knowledgeBaseIds: [],
    group: 'default',
    mcpTools: [mcpTool],
    resultMaxBytes: 4096,
    ...overrides,
  }
}

function call(overrides: Partial<MessageToolCall> = {}): MessageToolCall {
  return {
    id: 'call_mcp',
    name: 'mcp__github__ping',
    arguments: '{"repo":"new-api"}',
    status: 'pending',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('an MCP call reaches the gateway with the configured connection and stored arguments', async () => {
  vi.mocked(callPlaygroundMCPTool).mockResolvedValue({
    isError: false,
    content: [{ type: 'text', text: 'pong' }],
  })

  const outcome = await executeSupportedToolCall(call(), scope())

  expect(callPlaygroundMCPTool).toHaveBeenCalledWith(
    'github',
    'ping',
    { repo: 'new-api' },
    undefined
  )
  expect(outcome.status).toBe('completed')
  expect(JSON.parse(outcome.result ?? '{}')).toEqual({
    server: 'GitHub',
    tool: 'ping',
    is_error: false,
    content: [{ type: 'text', text: 'pong' }],
  })
})

test('an upstream tool failure is stored as a completed answer the model can read', async () => {
  vi.mocked(callPlaygroundMCPTool).mockResolvedValue({
    isError: true,
    content: [{ type: 'text', text: 'permission denied' }],
  })

  const outcome = await executeSupportedToolCall(call(), scope())

  expect(outcome.status).toBe('completed')
  expect(JSON.parse(outcome.result ?? '{}')).toMatchObject({
    is_error: true,
    content: [{ type: 'text', text: 'permission denied' }],
  })
})

test('a call whose connection went away reports the stable unavailable error', async () => {
  const outcome = await executeSupportedToolCall(
    call({ name: 'mcp__github__gone' }),
    scope({ mcpTools: [] })
  )

  expect(outcome.status).toBe('error')
  expect(outcome.errorMessage).toBe(
    PLAYGROUND_TOOL_EXECUTION_ERRORS.MCP_TOOL_UNAVAILABLE
  )
  expect(callPlaygroundMCPTool).not.toHaveBeenCalled()
})
