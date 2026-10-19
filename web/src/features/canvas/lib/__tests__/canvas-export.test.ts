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
import { expect, test, vi } from 'vitest'

import { CANVAS_PNG_EXPORT_MESSAGES } from '../../constants'
import type { CanvasFlowNode, CanvasNodeKind } from '../../types'
import {
  canvasPngExportFilename,
  canvasPngExportLayout,
  canvasPngExportNodeIds,
  renderCanvasPng,
  wrapCanvasExportText,
} from '../canvas-export'

function node(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 50,
  options: {
    kind?: CanvasNodeKind
    parentId?: string
    selected?: boolean
    text?: string
  } = {}
): CanvasFlowNode {
  return {
    id,
    type: options.kind ?? 'text',
    position: { x, y },
    measured: { width, height },
    selected: options.selected ?? false,
    parentId: options.parentId,
    data: {
      kind: options.kind ?? 'text',
      ...(options.text ? { text: options.text } : {}),
    },
  } as CanvasFlowNode
}

test('selection expands a selected group to its children', () => {
  const nodes = [
    node('group', 100, 100, 300, 200, {
      kind: 'group',
      selected: true,
    }),
    node('child', 10, 10, 80, 40, { parentId: 'group' }),
    node('other', 600, 100),
  ]
  expect(canvasPngExportNodeIds(nodes, 'selection')).toEqual(
    new Set(['group', 'child'])
  )
  expect(canvasPngExportNodeIds(nodes, 'canvas')).toEqual(
    new Set(['group', 'child', 'other'])
  )
})

test('selection without a selected node has no export ids', () => {
  expect(canvasPngExportNodeIds([node('n1', 0, 0)], 'selection')).toBeNull()
})

test('layout includes group offsets and clamps the raster size', () => {
  const nodes = [
    node('group', 100, 100, 300, 200, { kind: 'group' }),
    node('child', 10, 10, 80, 40, { parentId: 'group' }),
  ]
  const ids = canvasPngExportNodeIds(nodes, 'canvas')
  if (!ids) throw new Error('canvas scope should include nodes')
  const layout = canvasPngExportLayout(
    nodes,
    [{ id: 'edge', source: 'group', target: 'child' }],
    ids,
    { padding: 10, scale: 2, maxEdge: 1000 }
  )
  expect(layout).not.toBeNull()
  expect(layout?.bounds).toEqual({ x: 90, y: 90, width: 320, height: 220 })
  expect(layout?.width).toBe(640)
  expect(layout?.height).toBe(440)
  expect(layout?.nodes.find((entry) => entry.id === 'child')?.rect).toEqual({
    x: 110,
    y: 110,
    width: 80,
    height: 40,
  })
  expect(layout?.edges).toEqual([])

  const clamped = canvasPngExportLayout(nodes, [], ids, {
    padding: 0,
    scale: 4,
    maxEdge: 500,
  })
  expect(Math.max(clamped?.width ?? 0, clamped?.height ?? 0)).toBe(500)
})

test('PNG filenames are safe and mark a selection export', () => {
  expect(canvasPngExportFilename(' My / Board: 1 ', 'canvas')).toBe(
    'My - Board- 1.png'
  )
  expect(canvasPngExportFilename('Board', 'selection')).toBe(
    'Board-selection.png'
  )
  expect(canvasPngExportFilename('   ', 'canvas')).toBe('canvas.png')
})

test('text wrapping clips to the requested line count', () => {
  const context = {
    measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
  }
  expect(wrapCanvasExportText(context, 'one two three', 70, 2)).toEqual([
    'one two',
    'three',
  ])
  expect(wrapCanvasExportText(context, 'one two three four', 30, 2)).toEqual([
    'one',
    'tw…',
  ])
  expect(wrapCanvasExportText(context, '画布节点与连线测试', 30, 2)).toEqual([
    '画布节',
    '点与…',
  ])
  expect(wrapCanvasExportText(context, 'a 画布节点与连线测试', 30, 2)).toEqual([
    'a',
    '画布…',
  ])
})

test('renders a layout into a PNG blob', async () => {
  const operations = {
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
  }
  const context = {
    ...operations,
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 7 }) as TextMetrics,
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: (blob: Blob | null) => void) =>
      callback(new Blob(['png'], { type: 'image/png' })),
  } as unknown as HTMLCanvasElement

  const nodes = [node('n1', 0, 0, 100, 50, { text: 'Hello' })]
  const result = await renderCanvasPng(nodes, [], 'canvas', 'Board', {
    padding: 10,
    scale: 2,
    createCanvas: () => canvas,
  })

  expect(canvas.width).toBe(240)
  expect(canvas.height).toBe(140)
  expect(result.blob.type).toBe('image/png')
  expect(result.filename).toBe('Board.png')
  expect(operations.fillText).toHaveBeenCalledWith(
    'Hello',
    expect.any(Number),
    expect.any(Number),
    expect.any(Number)
  )
})

test('an empty selection reports a translatable error', async () => {
  await expect(
    renderCanvasPng([node('n1', 0, 0)], [], 'selection', 'Board')
  ).rejects.toThrow(CANVAS_PNG_EXPORT_MESSAGES.EMPTY_SELECTION)
})
