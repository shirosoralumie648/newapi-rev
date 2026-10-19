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

import { searchPlaygroundWeb } from '../../api'
import {
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
    return failedOutcome(PLAYGROUND_TOOL_EXECUTION_ERRORS.FAILED, maxBytes)
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
    if (error instanceof ToolExecutionError) {
      return failedOutcome(error.message, maxBytes)
    }
    const serverMessage = getServerMessage(error)
    return failedOutcome(
      serverMessage || PLAYGROUND_TOOL_EXECUTION_ERRORS.FAILED,
      maxBytes
    )
  }
}
