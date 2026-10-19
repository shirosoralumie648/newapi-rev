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
  reconnectEdge,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  CANVAS_MAX_EDGES,
  CANVAS_MAX_NODES,
  CANVAS_NODE_ADD_BASE,
  CANVAS_NODE_ADD_OFFSET,
  CANVAS_NUDGE_LARGE_STEP,
  CANVAS_NUDGE_STEP,
} from '../constants'
import {
  canvasAlignmentSnap,
  canvasDistributeSelection,
  canvasNodeRect,
  canvasNudgeSelection,
  canvasUnionRect,
  type CanvasAlignmentGuide,
  type CanvasDistributeAxis,
  type CanvasRect,
} from '../lib/canvas-align'
import {
  createCanvasEdge,
  createCanvasNode,
  fromServerDocument,
} from '../lib/canvas-document'
import {
  canvasCopySelection,
  canvasDescendantIds,
  canvasExpandRemovedNodes,
  canvasGroupSelection,
  canvasNodeKind,
  canvasPasteClipboard,
  canvasSelectAll,
  canvasSelectedTopLevel,
  canvasUngroupSelection,
  type CanvasClipboard,
} from '../lib/canvas-edit'
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
  /** Coalesces rapid edits of the same target into one undo entry. */
  mergeKey?: string
}

interface CanvasEditorOptions {
  /** Binds the canvas editing shortcuts (undo/redo, copy/paste, group). */
  shortcutsEnabled?: boolean
  /** Reports a rejected connection with a translatable message key. */
  onRejectedConnection?: (messageKey: string) => void
}

/** One node a caller adds in a single undoable step. */
export interface CanvasAddedNode {
  kind: CanvasNodeKind
  position: { x: number; y: number }
  data?: Partial<CanvasNodeData>
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
  /** Coalesces rapid edits (typing, parameter changes) into one undo entry. */
  mergeKey?: string
}

/** The subset of the drag stream the editor needs to snap and undo a move. */
interface CanvasDragState {
  /** Top-level nodes whose stored position changes. */
  roots: Set<string>
  /** Every node that moves with the roots (group descendants included). */
  moving: Set<string>
  startPositions: Map<string, { x: number; y: number }>
  targets: CanvasRect[]
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
        const nextHistory = pushCanvasHistory(
          historyRef.current,
          {
            nodes: nextNodes,
            edges: nextEdges,
          },
          changeOptions.mergeKey ? { key: changeOptions.mergeKey } : undefined
        )
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

  const [alignmentGuides, setAlignmentGuides] = useState<
    CanvasAlignmentGuide[]
  >([])
  const dragRef = useRef<CanvasDragState | null>(null)

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyNodeChanges(
        changes as NodeChange<CanvasFlowNode>[],
        nodesRef.current
      )
      const removedIds = new Set(
        changes
          .filter((change) => change.type === 'remove')
          .map((change) => change.id)
      )
      const removesNodes = removedIds.size > 0
      // The drag stop callback records the final position once; xyflow sends
      // its own `dragging: false` position change just before that callback.
      const recordsHistory =
        dragRef.current === null &&
        changes.some(
          (change) =>
            change.type === 'remove' ||
            (change.type === 'position' && change.dragging === false)
        )
      let committedNodes = nextNodes
      let nextEdges = edgesRef.current
      if (removesNodes) {
        // A deleted group takes its children with it instead of leaving nodes
        // that point at a parent which no longer exists.
        const expanded = canvasExpandRemovedNodes(nodesRef.current, removedIds)
        committedNodes = nextNodes.filter((node) => !expanded.has(node.id))
        const present = new Set(committedNodes.map((node) => node.id))
        nextEdges = nextEdges.filter(
          (edge) => present.has(edge.source) && present.has(edge.target)
        )
      }
      commit(committedNodes, nextEdges, {
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

  const addNodes = useCallback(
    (entries: CanvasAddedNode[]): number => {
      const room = CANVAS_MAX_NODES - nodesRef.current.length
      if (room <= 0 || entries.length === 0) return 0
      const accepted = entries.slice(0, room)
      const created = accepted.map((entry) =>
        createCanvasNode(entry.kind, entry.position, entry.data)
      )
      commit([...nodesRef.current, ...created], edgesRef.current, {
        record: true,
        notify: true,
      })
      return accepted.length
    },
    [commit]
  )

  /**
   * Adds a small graph in one undoable step: the entries become nodes and the
   * links connect them by entry index. A link that would exceed the edge budget
   * drops the whole graph instead of saving a partial one, and a graph larger
   * than the remaining node room is refused for the same reason.
   */
  const addGraph = useCallback(
    (
      entries: CanvasAddedNode[],
      links: { source: number; target: number }[]
    ): string[] | null => {
      if (entries.length === 0) return null
      if (
        nodesRef.current.length + entries.length > CANVAS_MAX_NODES ||
        edgesRef.current.length + links.length > CANVAS_MAX_EDGES
      ) {
        return null
      }
      const created = entries.map((entry) =>
        createCanvasNode(entry.kind, entry.position, entry.data)
      )
      const createdEdges = links.flatMap((link) => {
        const source = created[link.source]
        const target = created[link.target]
        if (!source || !target || source.id === target.id) return []
        return [createCanvasEdge(source.id, target.id)]
      })
      commit(
        [...nodesRef.current, ...created],
        [...edgesRef.current, ...createdEdges],
        {
          record: true,
          notify: true,
        }
      )
      return created.map((node) => node.id)
    },
    [commit]
  )

  const addNode = useCallback(
    (kind: CanvasNodeKind, position?: { x: number; y: number }): boolean => {
      const cascade = CANVAS_NODE_ADD_OFFSET * (nodesRef.current.length % 8)
      return (
        addNodes([
          {
            kind,
            position: position ?? {
              x: CANVAS_NODE_ADD_BASE + cascade,
              y: CANVAS_NODE_ADD_BASE + cascade,
            },
          },
        ]) > 0
      )
    },
    [addNodes]
  )

  /**
   * Adds a node that is fed by an existing one and returns its id, or null when
   * the canvas is full. The node carries its data from the start, so a caller
   * that fills a result node needs no second update, and the link is one
   * history entry like any other structural edit.
   */
  const addLinkedNode = useCallback(
    (
      kind: CanvasNodeKind,
      sourceId: string,
      data: Partial<CanvasNodeData>,
      position: { x: number; y: number }
    ): string | null => {
      const source = nodesRef.current.find((node) => node.id === sourceId)
      if (!source) return null
      if (
        nodesRef.current.length >= CANVAS_MAX_NODES ||
        edgesRef.current.length >= CANVAS_MAX_EDGES
      ) {
        return null
      }
      const node = createCanvasNode(kind, position, data)
      const edge = createCanvasEdge(sourceId, node.id)
      commit([...nodesRef.current, node], [...edgesRef.current, edge], {
        record: true,
        notify: true,
      })
      return node.id
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
        mergeKey: updateOptions.mergeKey,
      })
    },
    [commit]
  )

  /**
   * Marks one result of a batch preferred. The source step and every sibling
   * result are written in one history entry so downstream resolution can
   * trust a single preferred id.
   */
  const setWorkflowPreferredResult = useCallback(
    (nodeId: string) => {
      const result = nodesRef.current.find((node) => node.id === nodeId)
      const sourceNodeId = result?.data.workflow?.sourceNodeId?.trim()
      if (!sourceNodeId) return
      let changed = false
      const nextNodes = nodesRef.current.map((node) => {
        if (node.id === sourceNodeId) {
          if (node.data.workflow?.preferredResultNodeId === nodeId) return node
          changed = true
          return {
            ...node,
            data: {
              ...node.data,
              workflow: {
                ...node.data.workflow,
                preferredResultNodeId: nodeId,
              },
            },
          }
        }
        if (node.data.workflow?.sourceNodeId?.trim() !== sourceNodeId) {
          return node
        }
        const preferred = node.id === nodeId
        if (node.data.workflow?.preferred === preferred) return node
        changed = true
        return {
          ...node,
          data: {
            ...node.data,
            workflow: { ...node.data.workflow, preferred },
          },
        }
      })
      if (!changed) return
      commit(nextNodes, edgesRef.current, { record: true, notify: true })
    },
    [commit]
  )

  const deleteSelection = useCallback((): boolean => {
    const selectedNodeIds = new Set(
      nodesRef.current
        .filter((node) => node.selected === true)
        .map((node) => node.id)
    )
    const selectedEdgeIds = new Set(
      edgesRef.current
        .filter((edge) => edge.selected === true)
        .map((edge) => edge.id)
    )
    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return false
    const removed = canvasExpandRemovedNodes(nodesRef.current, selectedNodeIds)
    const nextNodes = nodesRef.current.filter((node) => !removed.has(node.id))
    const nextEdges = edgesRef.current.filter(
      (edge) =>
        !selectedEdgeIds.has(edge.id) &&
        !removed.has(edge.source) &&
        !removed.has(edge.target)
    )
    commit(nextNodes, nextEdges, { record: true, notify: true })
    return true
  }, [commit])

  const nudgeSelection = useCallback(
    (dx: number, dy: number): boolean => {
      const nextNodes = canvasNudgeSelection(nodesRef.current, dx, dy)
      if (!nextNodes) return false
      const roots = canvasSelectedTopLevel(nodesRef.current)
      const mergeKey = `nudge:${roots
        .map((node) => node.id)
        .sort()
        .join(',')}`
      commit(nextNodes, edgesRef.current, {
        record: true,
        notify: true,
        mergeKey,
      })
      return true
    },
    [commit]
  )

  const distributeSelection = useCallback(
    (axis: CanvasDistributeAxis): boolean => {
      const nextNodes = canvasDistributeSelection(nodesRef.current, axis)
      if (!nextNodes) return false
      commit(nextNodes, edgesRef.current, { record: true, notify: true })
      return true
    },
    [commit]
  )

  const handleReconnect = useCallback(
    (oldEdge: CanvasFlowEdge, connection: Connection) => {
      if (
        oldEdge.source === connection.source &&
        oldEdge.target === connection.target &&
        (oldEdge.sourceHandle ?? null) === (connection.sourceHandle ?? null) &&
        (oldEdge.targetHandle ?? null) === (connection.targetHandle ?? null)
      ) {
        return
      }
      // The replaced edge must not introduce a cycle through its new target.
      const others = edgesRef.current.filter((edge) => edge.id !== oldEdge.id)
      if (
        wouldCreateCanvasWorkflowCycle(
          others,
          connection.source,
          connection.target
        )
      ) {
        optionsRef.current.onRejectedConnection?.(CANVAS_WORKFLOW_ERRORS.CYCLE)
        return
      }
      const nextEdges = reconnectEdge(oldEdge, connection, edgesRef.current)
      if (nextEdges === edgesRef.current) return
      commit(nodesRef.current, nextEdges, { record: true, notify: true })
    },
    [commit]
  )

  const handleNodeDragStart: OnNodeDrag<CanvasFlowNode> = useCallback(
    (_event, node, draggedNodes) => {
      const byId = new Map(nodesRef.current.map((item) => [item.id, item]))
      const candidates = draggedNodes.length > 0 ? draggedNodes : [node]
      const candidateIds = new Set(candidates.map((item) => item.id))
      const roots = candidates.filter((item) => {
        let parentId = item.parentId
        for (let depth = 0; parentId && depth < 8; depth += 1) {
          if (candidateIds.has(parentId)) return false
          parentId = byId.get(parentId)?.parentId
        }
        return true
      })
      const rootIds = new Set(roots.map((item) => item.id))
      const moving = canvasDescendantIds(nodesRef.current, rootIds)
      dragRef.current = {
        roots: rootIds,
        moving,
        startPositions: new Map(
          nodesRef.current
            .filter((item) => rootIds.has(item.id))
            .map((item) => [item.id, { ...item.position }])
        ),
        targets: nodesRef.current
          .filter((item) => !moving.has(item.id))
          .map((item) => canvasNodeRect(item, byId)),
      }
    },
    []
  )

  const handleNodeDrag: OnNodeDrag<CanvasFlowNode> = useCallback(
    (_event, node, draggedNodes) => {
      const state = dragRef.current
      if (!state) return
      const rawById = new Map(
        nodesRef.current.map((item) => [item.id, item] as const)
      )
      for (const dragged of draggedNodes.length > 0 ? draggedNodes : [node]) {
        rawById.set(dragged.id, dragged)
      }
      const movingRect = canvasUnionRect(
        nodesRef.current
          .filter((item) => state.moving.has(item.id))
          .map((item) => canvasNodeRect(rawById.get(item.id) ?? item, rawById))
      )
      if (!movingRect) return
      const snap = canvasAlignmentSnap(movingRect, state.targets)
      if (snap.dx === 0 && snap.dy === 0) {
        setAlignmentGuides((current) => (current.length === 0 ? current : []))
        return
      }
      setAlignmentGuides(snap.guides)
      let changed = false
      const nextNodes = nodesRef.current.map((item) => {
        if (!state.roots.has(item.id)) return item
        const raw = rawById.get(item.id) ?? item
        const position = {
          x: raw.position.x + snap.dx,
          y: raw.position.y + snap.dy,
        }
        if (
          Math.abs(item.position.x - position.x) < 0.001 &&
          Math.abs(item.position.y - position.y) < 0.001
        ) {
          return item
        }
        changed = true
        return { ...item, position }
      })
      if (!changed) return
      commit(nextNodes, edgesRef.current, { record: false, notify: false })
    },
    [commit]
  )

  const handleNodeDragStop: OnNodeDrag<CanvasFlowNode> = useCallback(() => {
    const state = dragRef.current
    dragRef.current = null
    setAlignmentGuides([])
    if (!state) return
    const movedDuringDrag = nodesRef.current.some((item) => {
      if (!state.roots.has(item.id)) return false
      const start = state.startPositions.get(item.id)
      if (!start) return false
      return (
        Math.abs(start.x - item.position.x) > 0.01 ||
        Math.abs(start.y - item.position.y) > 0.01
      )
    })
    if (!movedDuringDrag) return
    const byId = new Map(nodesRef.current.map((item) => [item.id, item]))
    const movingRect = canvasUnionRect(
      nodesRef.current
        .filter((item) => state.moving.has(item.id))
        .map((item) => canvasNodeRect(item, byId))
    )
    if (!movingRect) return
    const snap = canvasAlignmentSnap(movingRect, state.targets)
    const nextNodes = nodesRef.current.map((item) => {
      if (!state.roots.has(item.id)) return item
      if (snap.dx === 0 && snap.dy === 0) return item
      return {
        ...item,
        position: {
          x: item.position.x + snap.dx,
          y: item.position.y + snap.dy,
        },
      }
    })
    commit(nextNodes, edgesRef.current, {
      record: true,
      notify: true,
      mergeKey: `move:${[...state.roots].sort().join(',')}`,
    })
  }, [commit])

  const deleteNode = useCallback(
    (id: string) => {
      // Removing a group through the inspector drops its children with it,
      // exactly like a keyboard delete of a selected box.
      const removed = canvasExpandRemovedNodes(nodesRef.current, new Set([id]))
      const nextNodes = nodesRef.current.filter((node) => !removed.has(node.id))
      if (nextNodes.length === nodesRef.current.length) return
      const nextEdges = edgesRef.current.filter(
        (edge) => !removed.has(edge.source) && !removed.has(edge.target)
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

  const [clipboard, setClipboard] = useState<CanvasClipboard | null>(null)

  const copySelection = useCallback((): boolean => {
    const copied = canvasCopySelection(nodesRef.current, edgesRef.current)
    if (!copied) return false
    setClipboard(copied)
    return true
  }, [])

  const pasteSelection = useCallback((): boolean => {
    if (!clipboard) return false
    const pasted = canvasPasteClipboard(clipboard, {
      nodes: nodesRef.current,
      edges: edgesRef.current,
    })
    if (!pasted) return false
    commit(pasted.nodes, pasted.edges, { record: true, notify: true })
    return true
  }, [clipboard, commit])

  const selectAll = useCallback(() => {
    const nextNodes = canvasSelectAll(nodesRef.current)
    if (nextNodes === nodesRef.current) return
    commit(nextNodes, edgesRef.current, { record: false, notify: false })
  }, [commit])

  const groupSelection = useCallback((): boolean => {
    const grouped = canvasGroupSelection(nodesRef.current, edgesRef.current)
    if (!grouped) return false
    commit(grouped.nodes, grouped.edges, { record: true, notify: true })
    return true
  }, [commit])

  const ungroupSelection = useCallback((): boolean => {
    const released = canvasUngroupSelection(nodesRef.current, edgesRef.current)
    if (!released) return false
    commit(released.nodes, released.edges, { record: true, notify: true })
    return true
  }, [commit])

  const shortcutsEnabled = options.shortcutsEnabled ?? true
  useEffect(() => {
    if (!shortcutsEnabled) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      const inOverlay =
        target instanceof HTMLElement &&
        target.closest(
          '[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [role="slider"]'
        ) !== null
      // Editable fields and open overlays keep their own undo/redo, copy/paste,
      // caret movement, deletion and arrow-key navigation.
      if (editing || inOverlay || event.altKey) return

      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) {
            redo()
          } else {
            undo()
          }
          return
        }
        if (key === 'y') {
          event.preventDefault()
          redo()
          return
        }
        if (key === 'a') {
          event.preventDefault()
          selectAll()
          return
        }
        // Copy and paste keep their browser meaning when the canvas has nothing
        // to offer: an empty selection or an empty editor clipboard.
        if (key === 'c' && !event.shiftKey) {
          if (copySelection()) event.preventDefault()
          return
        }
        if (key === 'v' && !event.shiftKey) {
          if (pasteSelection()) event.preventDefault()
          return
        }
        if (key === 'g') {
          event.preventDefault()
          if (event.shiftKey) {
            ungroupSelection()
          } else {
            groupSelection()
          }
        }
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (deleteSelection()) {
          event.preventDefault()
        }
        return
      }

      const direction = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }[event.key]
      if (!direction) return
      const step = event.shiftKey ? CANVAS_NUDGE_LARGE_STEP : CANVAS_NUDGE_STEP
      if (nudgeSelection(direction.x * step, direction.y * step)) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    copySelection,
    deleteSelection,
    groupSelection,
    nudgeSelection,
    pasteSelection,
    redo,
    selectAll,
    shortcutsEnabled,
    undo,
    ungroupSelection,
  ])

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

  /** Selects exactly one node (or clears the selection) without a history entry. */
  const selectNode = useCallback(
    (id: string | null) => {
      const nextNodes = nodesRef.current.map((node) => {
        const selected = node.id === id
        return node.selected === selected ? node : { ...node, selected }
      })
      commit(nextNodes, edgesRef.current, { record: false, notify: false })
    },
    [commit]
  )

  const selectedNode = nodes.find((node) => node.selected === true) ?? null
  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0
  const selectedCount = nodes.filter((node) => node.selected === true).length
  const hasClipboard = (clipboard?.nodes.length ?? 0) > 0
  const canGroup = nodes.some(
    (node) => node.selected === true && canvasNodeKind(node) !== 'group'
  )
  const canUngroup = nodes.some(
    (node) =>
      node.selected === true &&
      (Boolean(node.parentId) || canvasNodeKind(node) === 'group')
  )
  const canDistribute = canvasSelectedTopLevel(nodes).length >= 3

  return {
    nodes,
    edges,
    selectedNode,
    selectedCount,
    canUndo,
    canRedo,
    canGroup,
    canUngroup,
    canDistribute,
    hasClipboard,
    alignmentGuides,
    handleNodesChange,
    handleEdgesChange,
    handleConnect,
    handleReconnect,
    handleNodeDragStart,
    handleNodeDrag,
    handleNodeDragStop,
    addNode,
    addNodes,
    addGraph,
    addLinkedNode,
    updateNodeData,
    setWorkflowPreferredResult,
    deleteNode,
    deleteSelection,
    nudgeSelection,
    distributeSelection,
    undo,
    redo,
    copySelection,
    pasteSelection,
    selectAll,
    groupSelection,
    ungroupSelection,
    replaceDocument,
    clearSelection,
    selectNode,
  }
}
