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
import type { PlaygroundMCPCallResult, PlaygroundMCPServer } from '../../api'
import { PLAYGROUND_MCP_MAX_DECLARED_TOOLS } from '../../constants'
import type { ChatCompletionTool } from '../../types'

/**
 * One callable MCP tool resolved to its connection. The model only ever sees
 * `functionName`; the endpoint and its credential stay on the gateway, and the
 * gateway refuses a tool call for a connection that is not administrator
 * enabled.
 */
export interface PlaygroundMCPToolRef {
  serverId: string
  serverName: string
  /** Upstream tool name inside the connection. */
  toolName: string
  /** Provider-safe `mcp__<server>__<tool>` name the model calls. */
  functionName: string
  description?: string
  parameters?: Record<string, unknown>
}

/** One enabled connection as the composer describes it to the account. */
export interface PlaygroundMCPServerSummary {
  id: string
  name: string
  /** False while the connection is enabled but its catalog is unreachable. */
  available: boolean
  toolCount: number
}

/**
 * The tools the account may call right now: every tool of an enabled and
 * reachable connection, in catalog order and bounded by the local declaration
 * ceiling. A connection that answered `available: false` contributes nothing,
 * so a broken server never removes a name the model could call.
 */
export function buildMCPToolRefs(
  servers: readonly PlaygroundMCPServer[] | undefined
): PlaygroundMCPToolRef[] {
  if (!servers?.length) return []
  const refs: PlaygroundMCPToolRef[] = []
  const names = new Set<string>()
  for (const server of servers) {
    if (!server.available) continue
    for (const tool of server.tools) {
      if (refs.length >= PLAYGROUND_MCP_MAX_DECLARED_TOOLS) return refs
      if (!tool.functionName || names.has(tool.functionName)) continue
      names.add(tool.functionName)
      refs.push({
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        functionName: tool.functionName,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
      })
    }
  }
  return refs
}

/** The OpenAI wire definitions of the resolved MCP tools. */
export function buildMCPToolDeclarations(
  refs: readonly PlaygroundMCPToolRef[]
): ChatCompletionTool[] {
  return refs.map((ref) => ({
    type: 'function' as const,
    function: {
      name: ref.functionName,
      ...(ref.description ? { description: ref.description } : {}),
      ...(ref.parameters ? { parameters: ref.parameters } : {}),
    },
  }))
}

/** The connection summary the composer shows next to the account switch. */
export function summarizeMCPServers(
  servers: readonly PlaygroundMCPServer[] | undefined
): PlaygroundMCPServerSummary[] {
  if (!servers?.length) return []
  return servers.map((server) => ({
    id: server.id,
    name: server.name,
    available: server.available,
    toolCount: server.available
      ? Math.min(server.tools.length, PLAYGROUND_MCP_MAX_DECLARED_TOOLS)
      : 0,
  }))
}

/** Resolves one model-produced call name to a connection tool, or null. */
export function findMCPToolRef(
  name: string,
  refs: readonly PlaygroundMCPToolRef[]
): PlaygroundMCPToolRef | null {
  const normalized = name.trim()
  if (!normalized) return null
  return refs.find((ref) => ref.functionName === normalized) ?? null
}

/**
 * The model-facing result of one proxied call. The gateway normalized the
 * upstream content already; the connection and tool names are added so the
 * model can tell several servers apart when a turn calls more than one.
 */
export function buildMCPToolResult(
  ref: PlaygroundMCPToolRef,
  result: PlaygroundMCPCallResult
): string {
  return JSON.stringify({
    server: ref.serverName,
    tool: ref.toolName,
    is_error: result.isError,
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structured_content: result.structuredContent }
      : {}),
  })
}
