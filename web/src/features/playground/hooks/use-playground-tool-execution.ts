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
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getMessageToolCalls,
  getPendingToolCalls,
  updateVersionToolCallStatus,
} from '../lib/message/message-tool-call-utils'
import { getCurrentVersion } from '../lib/message/message-utils'
import type { PlaygroundMCPToolRef } from '../lib/tools/mcp-tools'
import {
  countToolRoundsSinceLastUser,
  getPendingExecutableToolCalls,
  getToolLoopMessage,
  toolCallExecutionKey,
  toolCallVersionKey,
} from '../lib/tools/tool-execution'
import {
  executeSupportedToolCall,
  type ToolExecutionScope,
} from '../lib/tools/tool-executor'
import type { Message } from '../types'

interface UsePlaygroundToolExecutionOptions {
  /** Explicit account-level switch; automatic requests are never implicit. */
  enabled: boolean
  group: string
  /** True while a reply streams or a comparison runs. */
  isBusy: boolean
  /** Bases bound to the active conversation. */
  knowledgeBaseIds: readonly string[]
  /**
   * MCP tools the account may call right now. Must keep a stable identity
   * while the catalog is unchanged so a reactor render does not retry; when
   * the catalog arrives late the pending calls still execute.
   */
  mcpTools?: readonly PlaygroundMCPToolRef[]
  maxRounds: number
  messages: Message[]
  /** Continues the last settled tool-call reply through the normal chain. */
  onContinue: () => void
  onUpdateMessages: (
    updater: Message[] | ((previous: Message[]) => Message[]),
    sessionId?: string | null
  ) => void
  /** Server policy budget for one stored result. */
  resultMaxBytes: number
  sessionId: string | null
}

export interface PlaygroundToolExecutionState {
  /** Calls executing right now, keyed by message, version and call id. */
  executingKeys: ReadonlySet<string>
  /** Calls answered automatically during this mount. */
  autoFilledKeys: ReadonlySet<string>
  isExecuting: boolean
  /** Aborts the in-flight calls; they stay pending for the manual path. */
  cancel: () => void
}

/**
 * Answers the declared executable tool calls of the latest settled assistant
 * reply without a manual paste. Every call is executed once per mount, the
 * result is written into the P6-02 snapshot through the version-scoped helper
 * (so a version switch mid-flight cannot write into the wrong branch), and the
 * conversation continues automatically while the reply still requests tools
 * and stays under the configured round limit.
 *
 * Unknown tools keep the manual result/deny path: while one is pending the
 * loop neither executes nor continues. A round the user answered by hand also
 * stays manual — only calls filled by this hook trigger an automatic
 * continuation, so loading a historical conversation never sends a request by
 * itself.
 */
export function usePlaygroundToolExecution(
  options: UsePlaygroundToolExecutionOptions
): PlaygroundToolExecutionState {
  const [executingKeys, setExecutingKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [autoFilledKeys, setAutoFilledKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const attemptedRef = useRef(new Set<string>())
  const controllerRef = useRef<AbortController | null>(null)
  const sequenceRef = useRef(0)
  const previousSessionRef = useRef(options.sessionId)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const cancel = useCallback(() => {
    sequenceRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    setExecutingKeys(new Set())
  }, [])

  // Disabling the switch aborts what is running; nothing is retried on its
  // own, so the calls fall back to the manual result path.
  useEffect(() => {
    if (!options.enabled) cancel()
  }, [options.enabled, cancel])

  // A conversation switch abandons in-flight calls and forgets which calls of
  // the previous conversation were already tried.
  useEffect(() => {
    if (previousSessionRef.current === options.sessionId) return
    previousSessionRef.current = options.sessionId
    cancel()
    attemptedRef.current = new Set()
    setAutoFilledKeys(new Set())
  }, [options.sessionId, cancel])

  // Unmounting aborts everything and forgets the attempt marks, so a
  // development StrictMode remount (or a real remount) retries instead of
  // leaving the calls stuck in the manual path.
  useEffect(() => {
    return () => {
      sequenceRef.current += 1
      controllerRef.current?.abort()
      controllerRef.current = null
      attemptedRef.current = new Set()
    }
  }, [])

  useEffect(() => {
    if (!options.enabled || options.isBusy) return

    const messages = options.messages
    const loopMessage = getToolLoopMessage(messages)
    if (!loopMessage) return
    const version = getCurrentVersion(loopMessage)
    if (!version) return
    const versionKey = toolCallVersionKey(loopMessage, version)
    const attempted = attemptedRef.current

    const pendingCalls = getPendingExecutableToolCalls(
      loopMessage,
      options.mcpTools
    ).filter(
      (call) =>
        !attempted.has(toolCallExecutionKey(loopMessage, version, call.id))
    )

    if (pendingCalls.length === 0) {
      if (getPendingToolCalls(loopMessage).length > 0) return
      if (countToolRoundsSinceLastUser(messages) >= options.maxRounds) return
      const calls = getMessageToolCalls(loopMessage)
      const allAutoFilled =
        calls.length > 0 &&
        calls.every((call) =>
          autoFilledKeys.has(
            toolCallExecutionKey(loopMessage, version, call.id)
          )
        )
      if (!allAutoFilled) return
      const continueKey = `continue:${versionKey}`
      if (attempted.has(continueKey)) return
      attempted.add(continueKey)
      optionsRef.current.onContinue()
      return
    }

    const keys = pendingCalls.map((call) =>
      toolCallExecutionKey(loopMessage, version, call.id)
    )
    for (const key of keys) attempted.add(key)
    setExecutingKeys((previous) => new Set([...previous, ...keys]))

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const sequence = sequenceRef.current
    const messageKey = loopMessage.key
    const versionId = version.id
    const targetSessionId = options.sessionId
    const scope: ToolExecutionScope = {
      knowledgeBaseIds: options.knowledgeBaseIds,
      group: options.group,
      mcpTools: options.mcpTools ?? [],
      resultMaxBytes: options.resultMaxBytes,
      signal: controller.signal,
    }

    void Promise.all(
      pendingCalls.map(async (call) => {
        const outcome = await executeSupportedToolCall(call, scope)
        if (sequence !== sequenceRef.current || controller.signal.aborted)
          return
        const latest = optionsRef.current
        latest.onUpdateMessages(
          (previous) =>
            updateVersionToolCallStatus(
              previous,
              messageKey,
              versionId,
              call.id,
              outcome.status,
              outcome.result,
              outcome.errorMessage
            ),
          targetSessionId
        )
        setAutoFilledKeys(
          (previous) =>
            new Set([
              ...previous,
              toolCallExecutionKey(loopMessage, version, call.id),
            ])
        )
      })
    ).finally(() => {
      if (sequence !== sequenceRef.current) return
      setExecutingKeys((previous) => {
        const next = new Set(previous)
        for (const key of keys) next.delete(key)
        return next
      })
      if (controllerRef.current === controller) controllerRef.current = null
    })
  }, [
    autoFilledKeys,
    options.enabled,
    options.group,
    options.isBusy,
    options.knowledgeBaseIds,
    options.maxRounds,
    options.mcpTools,
    options.messages,
    options.resultMaxBytes,
    options.sessionId,
  ])

  return {
    autoFilledKeys,
    cancel,
    executingKeys,
    isExecuting: executingKeys.size > 0,
  }
}
