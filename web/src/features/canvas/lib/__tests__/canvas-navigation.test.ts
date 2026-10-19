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
  canvasGenerationPrefill,
  canvasGenerationPrefillGraph,
  canvasGenerationSearch,
  canvasNodeSourceTarget,
  canvasSourceSearch,
} from '../canvas-navigation'

test('resolves a source target for message nodes', () => {
  expect(
    canvasNodeSourceTarget({ sessionId: 'pgs_1', messageKey: 'm1' })
  ).toEqual({ sessionId: 'pgs_1', messageKey: 'm1' })
})

test('resolves a source target that also carries an artifact', () => {
  expect(
    canvasNodeSourceTarget({ sessionId: 'pgs_1', artifactId: 'a1' })
  ).toEqual({ sessionId: 'pgs_1', artifactId: 'a1' })
})

test('returns no target for content-only nodes', () => {
  expect(canvasNodeSourceTarget({ messageKey: 'm1' })).toBeNull()
  expect(canvasNodeSourceTarget(undefined)).toBeNull()
})

test('maps a target to playground search params', () => {
  expect(canvasSourceSearch({ sessionId: 'pgs_1' })).toEqual({
    session: 'pgs_1',
  })
  expect(canvasSourceSearch({ sessionId: 'pgs_1', messageKey: 'm1' })).toEqual({
    session: 'pgs_1',
    message: 'm1',
  })
  expect(canvasSourceSearch({ sessionId: 'pgs_1', artifactId: 'a1' })).toEqual({
    session: 'pgs_1',
    artifact: 'a1',
  })
})

test('resolves a generation search into a bounded prefill', () => {
  expect(
    canvasGenerationPrefill({
      prompt: '  a red fox  ',
      generate: 'video',
      session: 'pgs_1',
      message: 'm1',
      attachment: 'a1, a2',
    })
  ).toEqual({
    prompt: 'a red fox',
    kind: 'video',
    sessionId: 'pgs_1',
    messageKey: 'm1',
    attachmentIds: ['a1', 'a2'],
  })
})

test('an unknown generation kind or an empty prompt is not a prefill', () => {
  expect(
    canvasGenerationPrefill({ generate: 'audio', prompt: 'hi' })
  ).toBeNull()
  expect(
    canvasGenerationPrefill({ generate: 'image', prompt: '   ' })
  ).toBeNull()
  expect(canvasGenerationPrefill({})).toBeNull()
})

test('maps a prefill back to the canvas generation search params', () => {
  expect(
    canvasGenerationSearch({
      prompt: 'a red fox',
      kind: 'image',
      sessionId: 'pgs_1',
      messageKey: 'm1',
      attachmentIds: ['a1'],
    })
  ).toEqual({
    prompt: 'a red fox',
    generate: 'image',
    session: 'pgs_1',
    message: 'm1',
    attachment: 'a1',
  })
})

test('builds a task graph with the reference attachments fed into the step', () => {
  const graph = canvasGenerationPrefillGraph(
    {
      prompt: 'a red fox',
      kind: 'image',
      sessionId: 'pgs_1',
      messageKey: 'm1',
      attachmentIds: ['a1', 'a2'],
    },
    0
  )

  expect(graph.entries).toHaveLength(3)
  expect(graph.entries[0]).toMatchObject({
    kind: 'task',
    data: {
      kind: 'task',
      text: 'a red fox',
      workflow: { generation: 'image' },
    },
  })
  expect(graph.entries[1]).toMatchObject({
    kind: 'attachment',
    data: {
      kind: 'attachment',
      ref: { sessionId: 'pgs_1', attachmentId: 'a1' },
    },
  })
  expect(graph.links).toEqual([
    { source: 1, target: 0 },
    { source: 2, target: 0 },
  ])
})
