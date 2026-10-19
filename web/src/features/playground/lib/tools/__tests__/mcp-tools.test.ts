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

import type { PlaygroundMCPServer } from '../../../api'
import {
  buildMCPToolDeclarations,
  buildMCPToolRefs,
  buildMCPToolResult,
  findMCPToolRef,
  summarizeMCPServers,
} from '../mcp-tools'

function server(
  overrides: Partial<PlaygroundMCPServer> = {}
): PlaygroundMCPServer {
  return {
    id: 'github',
    name: 'GitHub',
    available: true,
    tools: [
      {
        name: 'search_repositories',
        functionName: 'mcp__github__search_repositories',
        description: 'Find repositories',
        inputSchema: { type: 'object' },
      },
    ],
    ...overrides,
  }
}

describe('MCP tool resolution', () => {
  test('an available connection contributes its tools and an unreachable one none', () => {
    const refs = buildMCPToolRefs([
      server(),
      server({
        id: 'broken',
        name: 'Broken',
        available: false,
        tools: [
          {
            name: 'anything',
            functionName: 'mcp__broken__anything',
            description: '',
          },
        ],
      }),
    ])

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      serverId: 'github',
      serverName: 'GitHub',
      toolName: 'search_repositories',
      functionName: 'mcp__github__search_repositories',
      description: 'Find repositories',
      parameters: { type: 'object' },
    })
  })

  test('a duplicated function name is declared once', () => {
    const refs = buildMCPToolRefs([
      server({
        tools: [
          { name: 'ping', functionName: 'mcp__github__ping', description: '' },
          { name: 'ping', functionName: 'mcp__github__ping', description: '' },
        ],
      }),
    ])

    expect(refs.map((ref) => ref.functionName)).toEqual(['mcp__github__ping'])
  })

  test('a catalog without descriptions and schemas stays minimal', () => {
    const refs = buildMCPToolRefs([
      server({
        tools: [
          { name: 'ping', functionName: 'mcp__github__ping', description: '' },
        ],
      }),
    ])

    expect(refs[0].description).toBeUndefined()
    expect(refs[0].parameters).toBeUndefined()
    expect(buildMCPToolDeclarations(refs)).toEqual([
      {
        type: 'function',
        function: { name: 'mcp__github__ping' },
      },
    ])
  })

  test('the declaration ceiling bounds one request', () => {
    const tools = Array.from({ length: 70 }, (_, index) => ({
      name: `tool_${index}`,
      functionName: `mcp__github__tool_${index}`,
      description: '',
    }))

    expect(buildMCPToolRefs([server({ tools })]).length).toBe(64)
  })

  test('a call name resolves only against the current catalog', () => {
    const refs = buildMCPToolRefs([server()])

    expect(
      findMCPToolRef(' mcp__github__search_repositories ', refs)?.serverId
    ).toBe('github')
    expect(findMCPToolRef('mcp__github__missing', refs)).toBeNull()
    expect(findMCPToolRef('', refs)).toBeNull()
  })

  test('the composer summary keeps unreachable connections visible without tools', () => {
    const summaries = summarizeMCPServers([
      server(),
      server({ id: 'broken', name: 'Broken', available: false, tools: [] }),
    ])

    expect(summaries).toEqual([
      { id: 'github', name: 'GitHub', available: true, toolCount: 1 },
      { id: 'broken', name: 'Broken', available: false, toolCount: 0 },
    ])
  })
})

describe('MCP tool results', () => {
  test('the model result names the connection, the tool and the upstream failure flag', () => {
    const ref = buildMCPToolRefs([server()])[0]
    const result = JSON.parse(
      buildMCPToolResult(ref, {
        isError: false,
        content: [{ type: 'text', text: 'two repositories' }],
        structuredContent: { total: 2 },
      })
    )

    expect(result).toEqual({
      server: 'GitHub',
      tool: 'search_repositories',
      is_error: false,
      content: [{ type: 'text', text: 'two repositories' }],
      structured_content: { total: 2 },
    })
  })

  test('an upstream tool failure is reported without inventing structured content', () => {
    const ref = buildMCPToolRefs([server()])[0]
    const result = JSON.parse(
      buildMCPToolResult(ref, {
        isError: true,
        content: [{ type: 'text', text: 'not found' }],
      })
    )

    expect(result.is_error).toBe(true)
    expect(result).not.toHaveProperty('structured_content')
  })
})
