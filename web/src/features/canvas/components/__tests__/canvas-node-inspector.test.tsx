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
import { type ComponentProps, useState } from 'react'
import { expect, test, vi } from 'vitest'

import type { CanvasNodeDataUpdate } from '../../hooks/use-canvas-editor'
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

/**
 * Renders the inspector with the canvas editor's update contract: a data update
 * is applied to the node, so a controlled select that switches dependent fields
 * (the generation type of a task step) re-renders. Updates are also recorded on
 * the caller's spy.
 */
function CanvasNodeInspectorHarness(
  props: Omit<
    ComponentProps<typeof CanvasNodeInspector>,
    'node' | 'onUpdateData'
  > & {
    node: CanvasFlowNode
    onUpdateData: (id: string, update: CanvasNodeDataUpdate) => void
  }
) {
  const [node, setNode] = useState<CanvasFlowNode>(props.node)
  return (
    <CanvasNodeInspector
      {...props}
      node={node}
      onUpdateData={(id, update) => {
        props.onUpdateData(id, update)
        setNode((current) => ({
          ...current,
          data: {
            ...current.data,
            ...(typeof update === 'function' ? update(current.data) : update),
          },
        }))
      }}
    />
  )
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

test('inserts a mention of a connected resource into the instruction', async () => {
  const user = userEvent.setup()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspector
      mentions={[
        {
          nodeId: 'p1',
          label: 'Prompt',
          kind: 'prompt',
          hasText: true,
          hasImage: false,
        },
        {
          nodeId: 'a1',
          label: 'photo.png',
          kind: 'attachment',
          hasText: false,
          hasImage: true,
        },
      ]}
      models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
      node={makeNode({ kind: 'model', workflow: { model: 'gpt-4o' } })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={onUpdateData}
    />
  )

  const instruction = screen.getByRole('textbox', { name: 'Instruction' })
  await user.type(instruction, 'hello @')
  expect(screen.getByRole('button', { name: /photo\.png/ })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /photo\.png/ }))
  expect(onUpdateData).toHaveBeenCalledWith('n1', { text: 'hello @photo.png ' })
})

test('opens the mention picker from the insert reference action', async () => {
  const user = userEvent.setup()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspector
      mentions={[
        {
          nodeId: 'p1',
          label: 'Prompt',
          kind: 'prompt',
          hasText: true,
          hasImage: false,
        },
      ]}
      models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
      node={makeNode({ kind: 'model', workflow: { model: 'gpt-4o' } })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={onUpdateData}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Insert reference' }))
  await user.click(screen.getByRole('button', { name: /Prompt/ }))

  expect(onUpdateData).toHaveBeenCalledWith('n1', { text: '@Prompt ' })
})

test('configures the generation parameters and group of a task step', async () => {
  const user = userEvent.setup()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspectorHarness
      groups={[
        { label: 'default', value: 'default', ratio: 1 },
        { label: 'vip', value: 'vip', ratio: 1 },
      ]}
      models={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
      node={makeNode({
        kind: 'task',
        workflow: { model: 'gpt-image-1', generation: 'image' },
      })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={onUpdateData}
      runPhase='idle'
    />
  )

  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Quality' }),
    'high'
  )
  await user.selectOptions(screen.getByRole('combobox', { name: 'Count' }), '3')
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Group' }),
    'vip'
  )

  const patchOf = (index: number) =>
    onUpdateData.mock.calls[index][1] as (
      data: CanvasNodeData
    ) => Partial<CanvasNodeData>
  const base: CanvasNodeData = {
    kind: 'task',
    workflow: { model: 'gpt-image-1', generation: 'image' },
  }
  expect(patchOf(0)(base)).toEqual({
    workflow: { model: 'gpt-image-1', generation: 'image', quality: 'high' },
  })
  expect(patchOf(1)(base)).toEqual({
    workflow: { model: 'gpt-image-1', generation: 'image', imageCount: 3 },
  })
  expect(patchOf(2)(base)).toEqual({
    workflow: { model: 'gpt-image-1', generation: 'image', group: 'vip' },
  })

  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Generation type' }),
    'video'
  )
  expect(
    screen.getByRole('combobox', { name: 'Video size' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Quality' })).toBeNull()
})

test('shows the generation record of a result node and retries it', async () => {
  const user = userEvent.setup()
  const onRetry = vi.fn()
  render(
    <CanvasNodeInspector
      node={makeNode({
        kind: 'task-result',
        label: 'kling-v1 · video',
        ref: { taskId: 'task-1', taskArtifactKey: 'out-1' },
        workflow: {
          status: 'succeeded',
          model: 'kling-v1',
          generation: 'video',
          duration: 10,
          inputText: 'a sailing ship',
          group: 'vip',
          sourceNodeId: 't1',
        },
      })}
      onDelete={vi.fn()}
      onRetry={onRetry}
      onUpdateData={vi.fn()}
      runPhase='idle'
    />
  )

  expect(screen.getByText('Result')).toBeInTheDocument()
  expect(screen.getByText('a sailing ship')).toBeInTheDocument()
  expect(screen.getByText('kling-v1')).toBeInTheDocument()
  expect(screen.getByText('Video')).toBeInTheDocument()
  expect(screen.getByText('task-1')).toBeInTheDocument()
  expect(screen.getByText('out-1')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Retry generation' }))
  expect(onRetry).toHaveBeenCalledWith('n1')
})

test('hides the result retry while the workflow is running', () => {
  render(
    <CanvasNodeInspector
      node={makeNode({
        kind: 'task-result',
        workflow: {
          status: 'succeeded',
          model: 'kling-v1',
          sourceNodeId: 't1',
        },
      })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={vi.fn()}
      runPhase='running'
    />
  )

  expect(screen.queryByRole('button', { name: 'Retry generation' })).toBeNull()
})
