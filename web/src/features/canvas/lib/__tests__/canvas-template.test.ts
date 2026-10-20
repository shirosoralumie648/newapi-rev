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
import { expect, test } from 'vitest'

import { CANVAS_NODE_ESTIMATED_WIDTH } from '../../constants'
import type {
  CanvasFlowNode,
  CanvasServerDocument,
  CanvasTemplateAsset,
} from '../../types'
import {
  canvasTemplateAssetSource,
  canvasTemplateMaterialization,
  canvasTemplateOffset,
  canvasTemplateReferencedAttachments,
} from '../canvas-template'

const document: CanvasServerDocument = {
  viewport: { x: 10, y: 20, zoom: 0.75 },
  nodes: [
    {
      id: 'prompt',
      type: 'prompt',
      position: { x: 100, y: 40 },
      data: { kind: 'prompt', text: 'Describe a fox.' },
    },
    {
      id: 'attachment',
      type: 'attachment',
      position: { x: 20, y: 10 },
      width: 240,
      height: 160,
      data: {
        kind: 'attachment',
        parentId: 'prompt',
        sourceDeleted: true,
        ref: { sessionId: 'old-canvas', attachmentId: 'att-1' },
      },
    },
    {
      id: 'model',
      type: 'model',
      position: { x: 400, y: 40 },
      data: { kind: 'model', label: 'Generate', workflow: { model: 'gpt-4o' } },
    },
  ],
  edges: [
    {
      id: 'edge-1',
      source: 'prompt',
      target: 'attachment',
      source_handle: 'out',
      label: 'reference',
    },
    { id: 'edge-2', source: 'attachment', target: 'missing' },
  ],
}

test('reads the attachment claim of a template document once', () => {
  expect([...canvasTemplateReferencedAttachments(document)]).toEqual(['att-1'])
  expect(canvasTemplateReferencedAttachments({ nodes: [], edges: [] })).toEqual(
    new Set()
  )
})

test('uses the source attachment id and falls back to the asset row id', () => {
  const base = {
    id: 'pgta_1',
    filename: 'image.png',
    mediaType: 'image/png',
    byteSize: 10,
    contentHash: 'hash',
  } satisfies Omit<CanvasTemplateAsset, 'sourceAttachmentId'>
  expect(
    canvasTemplateAssetSource({ ...base, sourceAttachmentId: 'att-1' })
  ).toBe('att-1')
  expect(canvasTemplateAssetSource({ ...base, sourceAttachmentId: '' })).toBe(
    'pgta_1'
  )
})

test('materializes fresh ids, remaps the ref and keeps only valid edges', () => {
  const result = canvasTemplateMaterialization(
    document,
    { 'att-1': 'att-new' },
    'canvas-new',
    { x: 50, y: 5 }
  )

  expect(result.entries).toHaveLength(3)
  expect(result.links).toHaveLength(1)
  expect(result.droppedRefs).toBe(0)
  expect(result.document.viewport).toEqual(document.viewport)

  const prompt = result.document.nodes[0]
  const attachment = result.document.nodes[1]
  const model = result.document.nodes[2]
  expect(prompt.id).not.toBe('prompt')
  expect(new Set([prompt.id, attachment.id, model.id]).size).toBe(3)
  expect(attachment.position).toEqual({ x: 70, y: 15 })
  expect(attachment.width).toBe(240)
  expect(attachment.height).toBe(160)
  expect(attachment.data).toEqual({
    kind: 'attachment',
    parentId: prompt.id,
    ref: { sessionId: 'canvas-new', attachmentId: 'att-new' },
  })
  expect(document.nodes[1].data).toEqual({
    kind: 'attachment',
    parentId: 'prompt',
    sourceDeleted: true,
    ref: { sessionId: 'old-canvas', attachmentId: 'att-1' },
  })

  expect(result.document.edges).toEqual([
    {
      id: expect.any(String),
      source: prompt.id,
      target: attachment.id,
      source_handle: 'out',
      label: 'reference',
    },
  ])
  expect(result.links).toEqual([
    { source: 0, target: 1, sourceHandle: 'out', label: 'reference' },
  ])
  expect(result.entries[1]).toEqual({
    id: attachment.id,
    kind: 'attachment',
    position: { x: 70, y: 15 },
    data: attachment.data,
  })
})

test('drops a reference the apply path did not upload and counts it', () => {
  const result = canvasTemplateMaterialization(
    document,
    {},
    'canvas-new',
    { x: 0, y: 0 },
    false
  )

  expect(result.droppedRefs).toBe(1)
  expect(result.document.nodes[1].data).toEqual({
    kind: 'attachment',
    parentId: result.document.nodes[0].id,
  })
  expect(result.document).not.toHaveProperty('viewport')
})

test('places a template beside the rightmost existing node', () => {
  const nodes: CanvasFlowNode[] = [
    {
      id: 'n1',
      type: 'prompt',
      position: { x: 100, y: 0 },
      measured: { width: 120, height: 80 },
      data: { kind: 'prompt' },
    },
    {
      id: 'n2',
      type: 'note',
      position: { x: 260, y: 0 },
      data: { kind: 'note' },
    },
  ]

  expect(canvasTemplateOffset(nodes, document, 80)).toEqual({
    x:
      260 +
      CANVAS_NODE_ESTIMATED_WIDTH +
      80 -
      Math.min(...document.nodes.map((node) => node.position.x)),
    y: 0,
  })
  expect(canvasTemplateOffset([], document)).toEqual({ x: 0, y: 0 })
  expect(canvasTemplateOffset(nodes, { nodes: [], edges: [] })).toEqual({
    x: 0,
    y: 0,
  })
})
