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
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CANVAS_MAX_NODES, CANVAS_NODE_ADD_OFFSET } from '../constants'
import { createCanvasNode, fromServerDocument } from '../lib/canvas-document'
import {
  createCanvasHistory,
  pushCanvasHistory,
  redoCanvasHistory,
  undoCanvasHistory,
  type CanvasSnapshot,
} from '../lib/canvas-history'
import {
  wouldCreateCanvasWorkflowCycle,
  CANVAS_WORKFLOW_ERRORS,
} from '../lib/canvas-workflow'
import type {
  CanvasFlowEdge,
  CanvasFlowNode,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasServerDocument,
} from '../types'

type EditorChangeNotifier = (
  nodes: CanvasFlowNode[],
  edges: CanvasFlowEdge[]
) => void

interface ApplyChangeOptions {
  /** Records an undo entry; live drag frames pass `false`. */
  record: boolean
  /** Notifies the autosave owner; selection-only updates pass `false`. */
  notify: boolean
}

interface CanvasEditorOptions {
  /** Binds Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y while mounted. */
  shortcutsEnabled?: boolean
  /** Reports a rejected connection with a translatable message key. */
  onRejectedConnection?: (messageKey: string) => void
}

/**
 * A node data edit is either a partial patch or a function of the latest data,
 * so callers that merge nested state (a workflow run) never overwrite fields an
 * earlier edit of the same tick already stored.
 */
export type CanvasNodeDataUpdate =
  | Partial<CanvasNodeData>
  | ((data: CanvasNodeData) => Partial<CanvasNodeData>)

export interface CanvasNodeDataUpdateOptions {
  /** Records an undo entry; run-state updates stay out of history. */
  record?: boolean
}

/**
 * Owns the editable node/edge graph of one canvas project: selection, node and
 * edge mutations, undo/redo history and the position stream while dragging.
 * The autosave document is built and validated by the caller through
 * `onChange`.
 */
export function useCanvasEditor(
  initial: CanvasServerDocument,
  onChange: EditorChangeNotifier,
  options: CanvasEditorOptions = {}
) {
  const restored = useMemo(() => fromServerDocument(initial), [initial])
  const [nodes, setNodes] = useState<CanvasFlowNode[]>(restored.nodes)
  const [edges, setEdges] = useState<CanvasFlowEdge[]>(restored.edges)
  const [history, setHistory] = useState(() =>
    createCanvasHistory({ nodes: restored.nodes, edges: restored.edges })
  )

  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const historyRef = useRef(history)
  const onChangeRef = useRef(onChange)
  const optionsRef = useRef(options)
  nodesRef.current = nodes
  edgesRef.current = edges
  historyRef.current = history
  onChangeRef.current = onChange
  optionsRef.current = options

  const commit = useCallback(
    (
      nextNodes: CanvasFlowNode[],
      nextEdges: CanvasFlowEdge[],
      changeOptions: ApplyChangeOptions
    ) => {
      nodesRef.current = nextNodes
      edgesRef.current = nextEdges
      setNodes(nextNodes)
      setEdges(nextEdges)
      if (changeOptions.record) {
        const nextHistory = pushCanvasHistory(historyRef.current, {
          nodes: nextNodes,
          edges: nextEdges,
        })
        historyRef.current = nextHistory
        setHistory(nextHistory)
      }
      if (changeOptions.notify) {
        onChangeRef.current(nextNodes, nextEdges)
      }
    },
    []
  )

  const applySnapshot = useCallback((snapshot: CanvasSnapshot) => {
    nodesRef.current = snapshot.nodes
    edgesRef.current = snapshot.edges
    setNodes(snapshot.nodes)
    setEdges(snapshot.edges)
    onChangeRef.current(snapshot.nodes, snapshot.edges)
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyNodeChanges(
        changes as NodeChange<CanvasFlowNode>[],
        nodesRef.current
      )
      const removesNodes = changes.some((change) => change.type === 'remove')
      const recordsHistory = changes.some(
        (change) =>
          change.type === 'remove' ||
          (change.type === 'position' && change.dragging === false)
      )
      let nextEdges = edgesRef.current
      if (removesNodes) {
        const present = new Set(nextNodes.map((node) => node.id))
        nextEdges = nextEdges.filter(
          (edge) => present.has(edge.source) && present.has(edge.target)
        )
      }
      commit(nextNodes, nextEdges, {
        record: recordsHistory,
        notify: recordsHistory,
      })
    },
    [commit]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const nextEdges = applyEdgeChanges(
        changes as EdgeChange<CanvasFlowEdge>[],
        edgesRef.current
      )
      const recordsHistory = changes.some((change) => change.type === 'remove')
      commit(nodesRef.current, nextEdges, {
        record: recordsHistory,
        notify: recordsHistory,
      })
    },
    [commit]
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      // The graph stays a general editor, but a workflow run consumes a DAG:
      // reject a connection that would close a cycle instead of executing an
      // arbitrary prefix of it later.
      if (
        wouldCreateCanvasWorkflowCycle(
          edgesRef.current,
          connection.source,
          connection.target
        )
      ) {
        optionsRef.current.onRejectedConnection?.(CANVAS_WORKFLOW_ERRORS.CYCLE)
        return
      }
      const nextEdges = addEdge(connection, edgesRef.current)
      if (nextEdges === edgesRef.current) return
      commit(nodesRef.current, nextEdges, { record: true, notify: true })
    },
    [commit]
  )

  const addNode = useCallback(
    (kind: CanvasNodeKind, position?: { x: number; y: number }): boolean => {
      if (nodesRef.current.length >= CANVAS_MAX_NODES) {
        return false
      }
      const cascade = CANVAS_NODE_ADD_OFFSET * (nodesRef.current.length % 8)
      const node = createCanvasNode(
        kind,
        position ?? { x: 96 + cascade, y: 96 + cascade }
      )
      commit([...nodesRef.current, node], edgesRef.current, {
        record: true,
        notify: true,
      })
      return true
    },
    [commit]
  )

  const updateNodeData = useCallback(
    (
      id: string,
      update: CanvasNodeDataUpdate,
      updateOptions: CanvasNodeDataUpdateOptions = {}
    ) => {
      let changed = false
      const nextNodes = nodesRef.current.map((node) => {
        if (node.id !== id) return node
        const patch = typeof update === 'function' ? update(node.data) : update
        changed = true
        return { ...node, data: { ...node.data, ...patch } }
      })
      if (!changed) return
      commit(nextNodes, edgesRef.current, {
        record: updateOptions.record ?? true,
        notify: true,
      })
    },
    [commit]
  )

  const deleteNode = useCallback(
    (id: string) => {
      const nextNodes = nodesRef.current.filter((node) => node.id !== id)
      if (nextNodes.length === nodesRef.current.length) return
      const nextEdges = edgesRef.current.filter(
        (edge) => edge.source !== id && edge.target !== id
      )
      commit(nextNodes, nextEdges, { record: true, notify: true })
    },
    [commit]
  )

  const undo = useCallback(() => {
    const result = undoCanvasHistory(historyRef.current)
    if (!result) return
    historyRef.current = result.history
    setHistory(result.history)
    applySnapshot(result.snapshot)
  }, [applySnapshot])

  const redo = useCallback(() => {
    const result = redoCanvasHistory(historyRef.current)
    if (!result) return
    historyRef.current = result.history
    setHistory(result.history)
    applySnapshot(result.snapshot)
  }, [applySnapshot])

  const shortcutsEnabled = options.shortcutsEnabled ?? true
  useEffect(() => {
    if (!shortcutsEnabled) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      // Editable fields keep their own native undo/redo.
      const target = event.target
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      if (editing) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          redo()
        } else {
          undo()
        }
      } else if (key === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcutsEnabled, undo, redo])

  const replaceDocument = useCallback(
    (document: CanvasServerDocument) => {
      const next = fromServerDocument(document)
      const snapshot = { nodes: next.nodes, edges: next.edges }
      historyRef.current = createCanvasHistory(snapshot)
      setHistory(historyRef.current)
      applySnapshot(snapshot)
    },
    [applySnapshot]
  )

  const clearSelection = useCallback(() => {
    const nextNodes = nodesRef.current.map((node) =>
      node.selected === true ? { ...node, selected: false } : node
    )
    commit(nextNodes, edgesRef.current, { record: false, notify: false })
  }, [commit])

  const selectedNode = nodes.find((node) => node.selected === true) ?? null
  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0

  return {
    nodes,
    edges,
    selectedNode,
    canUndo,
    canRedo,
    handleNodesChange,
    handleEdgesChange,
    handleConnect,
    addNode,
    updateNodeData,
    deleteNode,
    undo,
    redo,
    replaceDocument,
    clearSelection,
  }
}
