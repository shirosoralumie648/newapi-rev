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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { CanvasFlowNode, CanvasNodeData } from '../../types'
import { CanvasNodeInspector } from '../canvas-node-inspector'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

function makeNode(data: CanvasNodeData): CanvasFlowNode {
  return {
    id: 'n1',
    type: data.kind,
    position: { x: 0, y: 0 },
    data,
  } as CanvasFlowNode
}

test('opens the source conversation from a message node', async () => {
  const user = userEvent.setup()
  const onOpenSource = vi.fn()
  render(
    <CanvasNodeInspector
      node={makeNode({
        kind: 'message',
        text: 'hi',
        ref: { sessionId: 'pgs_1', messageKey: 'm1' },
      })}
      onDelete={vi.fn()}
      onOpenSource={onOpenSource}
      onUpdateData={vi.fn()}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Open conversation' }))
  expect(onOpenSource).toHaveBeenCalledWith({
    sessionId: 'pgs_1',
    messageKey: 'm1',
  })
  expect(screen.queryByRole('button', { name: 'Open artifact' })).toBeNull()
})

test('offers both the conversation and the artifact for artifact nodes', async () => {
  const user = userEvent.setup()
  const onOpenSource = vi.fn()
  render(
    <CanvasNodeInspector
      node={makeNode({
        kind: 'artifact',
        label: 'Report',
        ref: { sessionId: 'pgs_1', artifactId: 'a1' },
      })}
      onDelete={vi.fn()}
      onOpenSource={onOpenSource}
      onUpdateData={vi.fn()}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Open artifact' }))
  expect(onOpenSource).toHaveBeenCalledWith({
    sessionId: 'pgs_1',
    artifactId: 'a1',
  })
})

test('does not offer source navigation for a content-only node', () => {
  render(
    <CanvasNodeInspector
      node={makeNode({ kind: 'text', text: 'note' })}
      onDelete={vi.fn()}
      onOpenSource={vi.fn()}
      onUpdateData={vi.fn()}
    />
  )

  expect(screen.queryByRole('button', { name: 'Open conversation' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open artifact' })).toBeNull()
})

test('configures a workflow step and retries a failed attempt', async () => {
  const user = userEvent.setup()
  const onRetry = vi.fn()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspector
      models={[
        { label: 'gpt-4o', value: 'gpt-4o' },
        { label: 'gpt-4o-mini', value: 'gpt-4o-mini' },
      ]}
      node={makeNode({
        kind: 'model',
        workflow: {
          status: 'failed',
          model: 'gpt-4o',
          attempts: 2,
          error: 'upstream exploded',
        },
      })}
      onDelete={vi.fn()}
      onRetry={onRetry}
      onUpdateData={onUpdateData}
      runPhase='idle'
    />
  )

  expect(screen.getByText('Workflow')).toBeInTheDocument()
  expect(screen.getByText('Failed')).toBeInTheDocument()
  expect(screen.getByText('upstream exploded')).toBeInTheDocument()

  await user.selectOptions(screen.getByRole('combobox'), 'gpt-4o-mini')
  expect(onUpdateData).toHaveBeenCalledWith('n1', expect.any(Function))
  const update = onUpdateData.mock.calls[0][1] as (
    data: CanvasNodeData
  ) => Partial<CanvasNodeData>
  expect(update({ kind: 'model', workflow: { model: 'gpt-4o' } })).toEqual({
    workflow: { model: 'gpt-4o-mini' },
  })

  await user.click(screen.getByRole('button', { name: 'Retry step' }))
  expect(onRetry).toHaveBeenCalledWith('n1')
})

test('hides the retry action while the workflow is running', () => {
  render(
    <CanvasNodeInspector
      models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
      node={makeNode({
        kind: 'task',
        workflow: {
          status: 'canceled',
          model: 'gpt-image-1',
          generation: 'image',
        },
      })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={vi.fn()}
      runPhase='running'
    />
  )

  expect(screen.getByText('Canceled')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Retry step' })).toBeNull()
})
