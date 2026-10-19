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
import { getServerMessage } from '@/lib/server-error-message'

import { callPlaygroundMCPTool, searchPlaygroundWeb } from '../../api'
import {
  PLAYGROUND_MCP_TOOL_NAME_PREFIX,
  PLAYGROUND_TOOL_EXECUTION_ERRORS,
  TOOL_CALL_STATUS,
} from '../../constants'
import { searchKnowledgeBase } from '../../knowledge-api'
import type { MessageToolCall, MessageToolCallStatus } from '../../types'
import {
  KNOWLEDGE_RETRIEVAL_MAX_RESULTS,
  KNOWLEDGE_RETRIEVAL_TOP_K,
  mergeKnowledgeSearchResults,
} from '../knowledge/retrieval'
import {
  buildMCPToolResult,
  findMCPToolRef,
  type PlaygroundMCPToolRef,
} from './mcp-tools'
import {
  buildKnowledgeSearchToolResult,
  buildTimeToolResult,
  buildWebSearchToolResult,
  getExecutableToolKind,
  getNumberArgument,
  getStringArgument,
  parseToolArguments,
  ToolExecutionError,
  truncateToolResultBytes,
} from './tool-execution'

/** Conversation state one automatic call may read. */
export interface ToolExecutionScope {
  /** Bases bound to this conversation; the model cannot search another one. */
  knowledgeBaseIds: readonly string[]
  /** Group used for the embedding route, matching normal retrieval. */
  group: string
  /** MCP tools the administrator enabled and this account may call. */
  mcpTools?: readonly PlaygroundMCPToolRef[]
  /** Server policy budget for one stored result. */
  resultMaxBytes: number
  signal?: AbortSignal
}

/** One finished automatic call, ready to be written into the snapshot. */
export interface ToolExecutionOutcome {
  status: Extract<MessageToolCallStatus, 'completed' | 'error'>
  result?: string
  errorMessage?: string
}

function failedOutcome(
  messageKey: string,
  maxBytes: number
): ToolExecutionOutcome {
  return {
    status: TOOL_CALL_STATUS.ERROR,
    errorMessage: truncateToolResultBytes(messageKey, maxBytes),
  }
}

async function executeWebSearch(
  args: Record<string, unknown>,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ToolExecutionOutcome> {
  const query = getStringArgument(args, ['query', 'q', 'search_query'])
  if (!query) {
    return failedOutcome(
      PLAYGROUND_TOOL_EXECUTION_ERRORS.WEB_SEARCH_QUERY_REQUIRED,
      maxBytes
    )
  }
  const response = await searchPlaygroundWeb(query, signal)
  return {
    status: TOOL_CALL_STATUS.COMPLETED,
    result: truncateToolResultBytes(
      buildWebSearchToolResult(response),
      maxBytes
    ),
  }
}

async function executeKnowledgeSearch(
  args: Record<string, unknown>,
  scope: ToolExecutionScope
): Promise<ToolExecutionOutcome> {
  const query = getStringArgument(args, ['query', 'q', 'search_query'])
  if (!query) {
    return failedOutcome(
      PLAYGROUND_TOOL_EXECUTION_ERRORS.KB_SEARCH_QUERY_REQUIRED,
      scope.resultMaxBytes
    )
  }
  const requestedId = getStringArgument(args, [
    'knowledge_base_id',
    'knowledgeBaseId',
    'kb_id',
  ])
  if (requestedId && !scope.knowledgeBaseIds.includes(requestedId)) {
    return failedOutcome(
      PLAYGROUND_TOOL_EXECUTION_ERRORS.KB_NOT_SELECTED,
      scope.resultMaxBytes
    )
  }
  const ids = requestedId ? [requestedId] : scope.knowledgeBaseIds
  if (ids.length === 0) {
    return failedOutcome(
      PLAYGROUND_TOOL_EXECUTION_ERRORS.KB_NOT_BOUND,
      scope.resultMaxBytes
    )
  }
  const requestedTopK = getNumberArgument(args, ['top_k', 'topK'])
  const topK = Math.min(
    KNOWLEDGE_RETRIEVAL_MAX_RESULTS,
    Math.max(1, Math.floor(requestedTopK ?? KNOWLEDGE_RETRIEVAL_TOP_K))
  )
  const groups = await Promise.all(
    ids.map((knowledgeBaseId) =>
      searchKnowledgeBase(
        knowledgeBaseId,
        { query, topK, group: scope.group },
        scope.signal
      )
    )
  )
  return {
    status: TOOL_CALL_STATUS.COMPLETED,
    result: truncateToolResultBytes(
      buildKnowledgeSearchToolResult(
        query,
        mergeKnowledgeSearchResults(groups)
      ),
      scope.resultMaxBytes
    ),
  }
}

async function executeMCPTool(
  ref: PlaygroundMCPToolRef,
  args: Record<string, unknown>,
  scope: ToolExecutionScope
): Promise<ToolExecutionOutcome> {
  const result = await callPlaygroundMCPTool(
    ref.serverId,
    ref.toolName,
    args,
    scope.signal
  )
  // An upstream tool failure is a completed answer: the gateway already
  // normalized the content, and the model decides what to do with it. Only a
  // transport or gateway failure becomes a stored error.
  return {
    status: TOOL_CALL_STATUS.COMPLETED,
    result: truncateToolResultBytes(
      buildMCPToolResult(ref, result),
      scope.resultMaxBytes
    ),
  }
}

/** Maps a thrown execution failure to the stored outcome the model reads. */
function toolExecutionFailure(
  error: unknown,
  maxBytes: number
): ToolExecutionOutcome {
  if (error instanceof ToolExecutionError) {
    return failedOutcome(error.message, maxBytes)
  }
  return failedOutcome(
    getServerMessage(error) || PLAYGROUND_TOOL_EXECUTION_ERRORS.FAILED,
    maxBytes
  )
}

/**
 * Answer one declared executable call. The stored arguments are read as data
 * only; unsupported names are never reached because the caller filters them.
 */
export async function executeSupportedToolCall(
  call: MessageToolCall,
  scope: ToolExecutionScope
): Promise<ToolExecutionOutcome> {
  const maxBytes = Math.max(1, Math.floor(scope.resultMaxBytes))
  if (scope.signal?.aborted) {
    return failedOutcome(PLAYGROUND_TOOL_EXECUTION_ERRORS.FAILED, maxBytes)
  }
  const kind = getExecutableToolKind(call.name)
  if (!kind) {
    // A name outside the built-in set is still callable while it belongs to a
    // connection of the current catalog. A name that only looks like an MCP
    // tool reports the stable unavailable error instead of a generic failure.
    const mcpRef = findMCPToolRef(call.name, scope.mcpTools ?? [])
    if (!mcpRef) {
      const message = call.name.startsWith(PLAYGROUND_MCP_TOOL_NAME_PREFIX)
        ? PLAYGROUND_TOOL_EXECUTION_ERRORS.MCP_TOOL_UNAVAILABLE
        : PLAYGROUND_TOOL_EXECUTION_ERRORS.FAILED
      return failedOutcome(message, maxBytes)
    }
    const mcpArgs = parseToolArguments(call.arguments)
    if (!mcpArgs) {
      return failedOutcome(
        PLAYGROUND_TOOL_EXECUTION_ERRORS.INVALID_ARGUMENTS,
        maxBytes
      )
    }
    try {
      return await executeMCPTool(mcpRef, mcpArgs, scope)
    } catch (error) {
      return toolExecutionFailure(error, maxBytes)
    }
  }
  const args = parseToolArguments(call.arguments)
  if (!args) {
    return failedOutcome(
      PLAYGROUND_TOOL_EXECUTION_ERRORS.INVALID_ARGUMENTS,
      maxBytes
    )
  }

  try {
    switch (kind) {
      case 'get_time':
        return {
          status: TOOL_CALL_STATUS.COMPLETED,
          result: truncateToolResultBytes(
            buildTimeToolResult(
              new Date(),
              getStringArgument(args, ['timezone', 'time_zone', 'tz'])
            ),
            maxBytes
          ),
        }
      case 'web_search':
        return await executeWebSearch(args, maxBytes, scope.signal)
      case 'kb_search':
        return await executeKnowledgeSearch(args, scope)
    }
  } catch (error) {
    return toolExecutionFailure(error, maxBytes)
  }
}
