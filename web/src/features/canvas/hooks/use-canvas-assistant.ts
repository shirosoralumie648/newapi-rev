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
import { nanoid } from 'nanoid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useStreamRequest } from '@/features/playground/hooks/use-stream-request'
import type {
  ChatCompletionMessage,
  ModelOption,
} from '@/features/playground/types'

import {
  CANVAS_ASSISTANT_HISTORY_MAX_MESSAGES,
  CANVAS_ASSISTANT_INPUT_MAX_CHARS,
  CANVAS_ASSISTANT_MESSAGES,
  CANVAS_WORKFLOW_OUTPUT_MAX_CHARS,
} from '../constants'
import {
  canvasAssistantContextNodes,
  canvasAssistantInsertPosition,
  canvasAssistantReplyNodeData,
  canvasAssistantSystemPrompt,
  canvasAssistantTaskNodeData,
} from '../lib/canvas-assistant'
import { CANVAS_ERRORS } from '../lib/canvas-document'
import {
  canvasWorkflowNodeLabel,
  truncateCanvasWorkflowText,
} from '../lib/canvas-workflow'
import type {
  CanvasAssistantMode,
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
} from '../types'
import type { CanvasAddedNode } from './use-canvas-editor'

export type CanvasAssistantMessageStatus = 'streaming' | 'done' | 'error'

export interface CanvasAssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: CanvasAssistantMessageStatus
  /** Untranslated server error source of a failed reply. */
  error?: string
}

interface CanvasAssistantOptions {
  nodes: CanvasFlowNode[]
  edges: CanvasFlowEdge[]
  /** Selected node; the anchor of the context and of everything inserted. */
  anchorNode: CanvasFlowNode | null
  /** User group every assistant request runs in; the server re-validates it. */
  group: string
  models: ModelOption[]
  /** Adds a node fed by an existing one; null when the canvas is full. */
  addLinkedNode: (
    kind: CanvasNodeKind,
    sourceId: string,
    data: Partial<CanvasNodeData>,
    position: { x: number; y: number }
  ) => string | null
  /** Adds unlinked nodes; returns how many entries were accepted. */
  addNodes: (entries: CanvasAddedNode[]) => number
  /** Starts a workflow run from one step node. */
  runWorkflow: (nodeId: string) => void
}

/**
 * The canvas assistant conversation: a streaming chat over the selected node
 * and its upstream chain, plus the two ways a reply returns to the canvas - as
 * a text node, or as a generation step started from the reply. The requests go
 * through the Playground relay like every other canvas run, so billing,
 * permissions and provider access stay server-side.
 */
export function useCanvasAssistant(options: CanvasAssistantOptions) {
  const { sendStreamRequest, stopStream, isStreaming } = useStreamRequest()
  const [messages, setMessages] = useState<CanvasAssistantMessage[]>([])
  const [mode, setMode] = useState<CanvasAssistantMode>('chat')
  const [model, setModel] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  // A generation insert adds its step first and starts the run after the
  // editor committed it, because a run resolves its steps from the latest
  // node list.
  const [pendingRunId, setPendingRunId] = useState<string | null>(null)

  const nodesRef = useRef(options.nodes)
  const edgesRef = useRef(options.edges)
  const anchorRef = useRef(options.anchorNode)
  const groupRef = useRef(options.group)
  const modelRef = useRef(model)
  const modeRef = useRef(mode)
  const messagesRef = useRef(messages)
  const addLinkedNodeRef = useRef(options.addLinkedNode)
  const addNodesRef = useRef(options.addNodes)
  const runWorkflowRef = useRef(options.runWorkflow)
  // Guards a second send within the same tick, before `isStreaming` renders.
  const streamingRef = useRef(false)

  nodesRef.current = options.nodes
  edgesRef.current = options.edges
  anchorRef.current = options.anchorNode
  groupRef.current = options.group
  modelRef.current = model
  modeRef.current = mode
  messagesRef.current = messages
  addLinkedNodeRef.current = options.addLinkedNode
  addNodesRef.current = options.addNodes
  runWorkflowRef.current = options.runWorkflow

  // The assistant inherits the selected step's model when it is still usable,
  // and follows the group's model list when the selection or group changes.
  const anchorModel = options.anchorNode?.data.workflow?.model?.trim() ?? ''
  useEffect(() => {
    if (options.models.length === 0) return
    if (model && options.models.some((option) => option.value === model)) return
    const preferred = options.models.some(
      (option) => option.value === anchorModel
    )
      ? anchorModel
      : options.models[0].value
    setModel(preferred)
  }, [anchorModel, model, options.models])

  const contextNodes = useMemo(
    () =>
      canvasAssistantContextNodes(
        options.anchorNode,
        options.nodes,
        options.edges
      ),
    [options.anchorNode, options.edges, options.nodes]
  )

  useEffect(() => {
    if (!pendingRunId) return
    setPendingRunId(null)
    runWorkflowRef.current(pendingRunId)
  }, [pendingRunId])

  const send = useCallback(
    (text: string) => {
      if (streamingRef.current) return
      const instruction = text.trim().slice(0, CANVAS_ASSISTANT_INPUT_MAX_CHARS)
      if (!instruction) return
      const requestModel = modelRef.current
      if (!requestModel) {
        setMessage(CANVAS_ASSISTANT_MESSAGES.NO_MODEL)
        return
      }
      const context = canvasAssistantContextNodes(
        anchorRef.current,
        nodesRef.current,
        edgesRef.current
      )
      const history: ChatCompletionMessage[] = messagesRef.current
        .filter(
          (entry) => entry.status !== 'error' && entry.content.trim() !== ''
        )
        .map((entry) => ({ role: entry.role, content: entry.content }))
        .slice(-CANVAS_ASSISTANT_HISTORY_MAX_MESSAGES)
      const replyId = nanoid()
      setMessages((current) => [
        ...current,
        { id: nanoid(), role: 'user', content: instruction, status: 'done' },
        { id: replyId, role: 'assistant', content: '', status: 'streaming' },
      ])
      setMessage(null)
      streamingRef.current = true
      void sendStreamRequest(
        {
          model: requestModel,
          group: groupRef.current,
          messages: [
            { role: 'system', content: canvasAssistantSystemPrompt(context) },
            ...history,
            { role: 'user', content: instruction },
          ],
          stream: true,
        },
        {
          // Reasoning deltas are not part of the assistant reply text.
          onUpdate: (type, chunk) => {
            if (type !== 'content') return
            setMessages((current) =>
              current.map((entry) =>
                entry.id === replyId
                  ? { ...entry, content: entry.content + chunk }
                  : entry
              )
            )
          },
          onToolCalls: () => undefined,
          onRequestId: () => undefined,
          onUsage: () => undefined,
          onComplete: () => {
            streamingRef.current = false
            setMessages((current) =>
              current.map((entry) =>
                entry.id === replyId ? { ...entry, status: 'done' } : entry
              )
            )
          },
          onError: (error) => {
            streamingRef.current = false
            setMessages((current) =>
              current.map((entry) =>
                entry.id === replyId
                  ? { ...entry, status: 'error', error }
                  : entry
              )
            )
          },
        }
      )
    },
    [sendStreamRequest]
  )

  const stop = useCallback(() => {
    streamingRef.current = false
    stopStream()
    setMessages((current) =>
      current.map((entry) =>
        entry.status === 'streaming' ? { ...entry, status: 'done' } : entry
      )
    )
  }, [stopStream])

  /**
   * Inserts a reply as a text node: linked from the anchor when one is
   * selected, otherwise dropped at the toolbar's cascade. The text is bounded
   * like a model output, so a very long reply stays far below the server's
   * per-node data budget.
   */
  const insertReply = useCallback((text: string): boolean => {
    const reply = truncateCanvasWorkflowText(
      text.trim(),
      CANVAS_WORKFLOW_OUTPUT_MAX_CHARS
    )
    if (!reply) return false
    const anchor = anchorRef.current
    const position = canvasAssistantInsertPosition(anchor, nodesRef.current)
    const data = canvasAssistantReplyNodeData(reply)
    if (!anchor) {
      if (addNodesRef.current([{ kind: 'text', position, data }]) === 0) {
        setMessage(CANVAS_ERRORS.TOO_MANY_NODES)
        return false
      }
      return true
    }
    if (!addLinkedNodeRef.current('text', anchor.id, data, position)) {
      setMessage(CANVAS_ERRORS.TOO_MANY_NODES)
      return false
    }
    return true
  }, [])

  /**
   * Turns a reply into a generation step: a `task` node fed by the anchor
   * carries the reply as its instruction, and the existing workflow run then
   * submits it and settles a result node. The step is added first and the run
   * starts from the next render, because a run resolves its steps from the
   * latest node list.
   */
  const generate = useCallback((text: string): boolean => {
    const instruction = text.trim().slice(0, CANVAS_ASSISTANT_INPUT_MAX_CHARS)
    if (!instruction) return false
    const generation = modeRef.current
    if (generation === 'chat') return false
    const requestModel = modelRef.current
    if (!requestModel) {
      setMessage(CANVAS_ASSISTANT_MESSAGES.NO_MODEL)
      return false
    }
    const anchor = anchorRef.current
    if (!anchor) {
      setMessage(CANVAS_ASSISTANT_MESSAGES.ANCHOR_REQUIRED)
      return false
    }
    const nodeId = addLinkedNodeRef.current(
      'task',
      anchor.id,
      canvasAssistantTaskNodeData(requestModel, generation, instruction),
      canvasAssistantInsertPosition(anchor, nodesRef.current)
    )
    if (!nodeId) {
      setMessage(CANVAS_ERRORS.TOO_MANY_NODES)
      return false
    }
    setPendingRunId(nodeId)
    return true
  }, [])

  const clearMessage = useCallback(() => setMessage(null), [])

  return {
    mode,
    setMode,
    model,
    setModel,
    messages,
    streaming: isStreaming,
    message,
    clearMessage,
    contextCount: contextNodes.length,
    anchorLabel: options.anchorNode
      ? canvasWorkflowNodeLabel(options.anchorNode.data)
      : null,
    canGenerate: options.anchorNode !== null,
    send,
    stop,
    insertReply,
    generate,
  }
}
