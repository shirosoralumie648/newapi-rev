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

import {
  CANVAS_NODE_SEARCH_MAX_RESULTS,
  CANVAS_NODE_TAG_MAX_COUNT,
} from '../../constants'
import type { CanvasFlowNode } from '../../types'
import {
  canvasNodeSearchPreview,
  canvasSearchNodes,
  isCanvasNodeSearchShortcut,
  normalizeCanvasNodeColor,
  normalizeCanvasNodeTags,
} from '../canvas-organization'

function searchNode(
  id: string,
  kind: CanvasFlowNode['data']['kind'],
  data: Partial<CanvasFlowNode['data']> = {}
): CanvasFlowNode {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, ...data },
  }
}

test('normalizeCanvasNodeColor keeps only palette keys', () => {
  expect(normalizeCanvasNodeColor('red')).toBe('red')
  expect(normalizeCanvasNodeColor('pink')).toBe('pink')
  expect(normalizeCanvasNodeColor('chartreuse')).toBeUndefined()
  expect(normalizeCanvasNodeColor('RED')).toBeUndefined()
  expect(normalizeCanvasNodeColor(undefined)).toBeUndefined()
  expect(normalizeCanvasNodeColor(3)).toBeUndefined()
})

test('normalizeCanvasNodeTags trims, deduplicates and bounds an imported list', () => {
  const tags = normalizeCanvasNodeTags([
    ' hero ',
    'hero',
    '',
    'bad\0tag',
    'x'.repeat(25),
    'scene',
    ...Array.from({ length: 12 }, (_, index) => `tag-${index}`),
  ])

  expect(tags).toHaveLength(CANVAS_NODE_TAG_MAX_COUNT)
  expect(tags.slice(0, 2)).toEqual(['hero', 'scene'])
  expect(normalizeCanvasNodeTags('hero')).toEqual([])
  expect(normalizeCanvasNodeTags([1, null])).toEqual([])
})

test('canvasSearchNodes matches name, tag and content case-insensitively', () => {
  const nodes = [
    searchNode('n1', 'prompt', {
      label: 'Hero',
      text: 'a red fox',
      tags: ['animal'],
    }),
    searchNode('n2', 'model', { workflow: { output: 'fox answer' } }),
    searchNode('n3', 'note', { text: 'unrelated' }),
  ]

  expect(
    canvasSearchNodes(nodes, 'hero', 'all').map((node) => node.id)
  ).toEqual(['n1'])
  expect(
    canvasSearchNodes(nodes, 'animal', 'all').map((node) => node.id)
  ).toEqual(['n1'])
  expect(canvasSearchNodes(nodes, 'FOX', 'all').map((node) => node.id)).toEqual(
    ['n1', 'n2']
  )
  expect(canvasSearchNodes(nodes, 'zzz', 'all')).toEqual([])
})

test('canvasSearchNodes filters by node kind and matches the kind label', () => {
  const nodes = [
    searchNode('n1', 'prompt', { text: 'draft' }),
    searchNode('n2', 'model', { workflow: { model: 'gpt-4o' } }),
  ]

  expect(canvasSearchNodes(nodes, '', 'model').map((node) => node.id)).toEqual([
    'n2',
  ])
  expect(
    canvasSearchNodes(nodes, 'prompt', 'all').map((node) => node.id)
  ).toEqual(['n1'])
})

test('canvasSearchNodes bounds the number of returned matches', () => {
  const nodes = Array.from(
    { length: CANVAS_NODE_SEARCH_MAX_RESULTS + 5 },
    (_, i) => searchNode(`n${i}`, 'note', { text: 'same text' })
  )

  expect(canvasSearchNodes(nodes, '', 'all')).toHaveLength(
    CANVAS_NODE_SEARCH_MAX_RESULTS
  )
})

test('canvasNodeSearchPreview collapses whitespace and truncates the excerpt', () => {
  expect(
    canvasNodeSearchPreview({ kind: 'note', text: 'line one\n\n  line two' })
  ).toBe('line one line two')
  expect(
    canvasNodeSearchPreview({ kind: 'note', text: 'x'.repeat(200) })
  ).toHaveLength(160)
  expect(canvasNodeSearchPreview({ kind: 'note' })).toBe('')
})

test('isCanvasNodeSearchShortcut accepts Cmd+P and Ctrl+P only', () => {
  const base = {
    key: 'p',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  }

  expect(isCanvasNodeSearchShortcut({ ...base, metaKey: true })).toBe(true)
  expect(isCanvasNodeSearchShortcut({ ...base, ctrlKey: true })).toBe(true)
  expect(isCanvasNodeSearchShortcut({ ...base, key: 'P', ctrlKey: true })).toBe(
    true
  )
  expect(isCanvasNodeSearchShortcut(base)).toBe(false)
  expect(
    isCanvasNodeSearchShortcut({ ...base, metaKey: true, shiftKey: true })
  ).toBe(false)
  expect(
    isCanvasNodeSearchShortcut({ ...base, ctrlKey: true, altKey: true })
  ).toBe(false)
  expect(isCanvasNodeSearchShortcut({ ...base, key: 'o', metaKey: true })).toBe(
    false
  )
})
