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

test('commits node text while typing under one history merge key', async () => {
  const user = userEvent.setup()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspector
      node={makeNode({ kind: 'text', text: '' })}
      onDelete={vi.fn()}
      onUpdateData={onUpdateData}
    />
  )

  await user.type(
    screen.getByRole('textbox', { name: 'Node content' }),
    'hello'
  )
  expect(onUpdateData).toHaveBeenLastCalledWith(
    'n1',
    { text: 'hello' },
    { mergeKey: 'text:n1' }
  )
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
  expect(onUpdateData).toHaveBeenCalledWith('n1', expect.any(Function), {
    mergeKey: 'workflow:n1',
  })
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
  expect(onUpdateData).toHaveBeenCalledWith(
    'n1',
    { text: 'hello @photo.png ' },
    { mergeKey: 'text:n1' }
  )
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

  expect(onUpdateData).toHaveBeenCalledWith(
    'n1',
    { text: '@Prompt ' },
    { mergeKey: 'text:n1' }
  )
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

test('commits an explicit seed and reuses the last seed', async () => {
  const user = userEvent.setup()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspectorHarness
      models={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
      node={makeNode({
        kind: 'task',
        workflow: {
          model: 'gpt-image-1',
          generation: 'image',
          lastSeed: 1234,
        },
      })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={onUpdateData}
      runPhase='idle'
    />
  )

  const seed = screen.getByRole('textbox', { name: 'Seed' })
  expect(seed).toHaveAttribute('placeholder', 'Random')
  await user.type(seed, '42{Enter}')
  expect(onUpdateData).toHaveBeenLastCalledWith('n1', expect.any(Function), {
    mergeKey: 'workflow:n1',
  })
  const patch = onUpdateData.mock.calls.at(-1)?.[1] as (
    data: CanvasNodeData
  ) => Partial<CanvasNodeData>
  expect(
    patch({
      kind: 'task',
      workflow: {
        model: 'gpt-image-1',
        generation: 'image',
        lastSeed: 1234,
      },
    })
  ).toEqual({
    workflow: {
      model: 'gpt-image-1',
      generation: 'image',
      lastSeed: 1234,
      seed: 42,
    },
  })

  await user.click(screen.getByRole('button', { name: 'Use last result' }))
  expect(screen.getByRole('textbox', { name: 'Seed' })).toHaveValue('1234')
})

test('applies a bounded custom size and rejects one outside the range', async () => {
  const user = userEvent.setup()
  const onUpdateData = vi.fn()
  render(
    <CanvasNodeInspectorHarness
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
    screen.getByRole('combobox', { name: 'Size' }),
    'custom'
  )
  const customSize = screen.getByRole('textbox', {
    name: 'Size (WIDTHxHEIGHT)',
  })
  await user.type(customSize, '640x480')
  await user.click(screen.getByRole('button', { name: 'Apply' }))

  expect(onUpdateData).toHaveBeenLastCalledWith('n1', expect.any(Function), {
    mergeKey: 'workflow:n1',
  })
  const patch = onUpdateData.mock.calls.at(-1)?.[1] as (
    data: CanvasNodeData
  ) => Partial<CanvasNodeData>
  expect(
    patch({
      kind: 'task',
      workflow: { model: 'gpt-image-1', generation: 'image' },
    })
  ).toEqual({
    workflow: {
      model: 'gpt-image-1',
      generation: 'image',
      size: '640x480',
    },
  })

  await user.clear(customSize)
  await user.type(customSize, '9000x9000')
  await user.click(screen.getByRole('button', { name: 'Apply' }))

  expect(
    screen.getByText(
      'The size must use WIDTHxHEIGHT with each side between 64 and 8192 pixels.'
    )
  ).toBeInTheDocument()
  expect(onUpdateData).toHaveBeenCalledTimes(1)
})

test('shows why channel metadata disables an unavailable media type', () => {
  render(
    <CanvasNodeInspector
      modelCapabilities={{
        'gpt-image-1': { endpointTypes: ['openai-video'], usageFields: [] },
      }}
      models={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
      node={makeNode({
        kind: 'task',
        workflow: { model: 'gpt-image-1', generation: 'image' },
      })}
      onDelete={vi.fn()}
      onRetry={vi.fn()}
      onUpdateData={vi.fn()}
      runPhase='idle'
    />
  )

  expect(
    screen.getByText(
      "This model's channel metadata does not list image generation."
    )
  ).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Quality' })).toBeDisabled()
  expect(screen.getByRole('textbox', { name: 'Seed' })).toBeDisabled()
})

test('selects a preferred result from its batch', async () => {
  const user = userEvent.setup()
  const onPreferResult = vi.fn()
  render(
    <CanvasNodeInspector
      canPreferResult
      node={makeNode({
        kind: 'task-result',
        workflow: {
          status: 'succeeded',
          model: 'gpt-image-1',
          generation: 'image',
          sourceNodeId: 't1',
          preferred: false,
        },
      })}
      onDelete={vi.fn()}
      onPreferResult={onPreferResult}
      onRetry={vi.fn()}
      onUpdateData={vi.fn()}
      runPhase='idle'
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Set as preferred result' })
  )
  expect(onPreferResult).toHaveBeenCalledWith('n1')
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

test('opens one image tool per image node', async () => {
  const user = userEvent.setup()
  const onOpenImageTools = vi.fn()
  const node = makeNode({
    kind: 'image',
    label: 'photo',
    ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
  })
  render(
    <CanvasNodeInspector
      node={node}
      onDelete={vi.fn()}
      onOpenImageTools={onOpenImageTools}
      onUpdateData={vi.fn()}
    />
  )

  expect(screen.getByText('Image tools')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Crop image' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(node, 'crop')
  await user.click(screen.getByRole('button', { name: 'Redraw image area' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(node, 'redraw')
  await user.click(screen.getByRole('button', { name: 'Upscale image' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(node, 'upscale')
  await user.click(screen.getByRole('button', { name: 'Outpaint image' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(node, 'outpaint')
  await user.click(screen.getByRole('button', { name: 'Remove background' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(node, 'backgroundRemoval')
  await user.click(screen.getByRole('button', { name: 'Use style reference' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(node, 'styleReference')
})

test('hides image tools the available models do not advertise', async () => {
  const user = userEvent.setup()
  const onOpenImageTools = vi.fn()
  render(
    <CanvasNodeInspector
      modelCapabilities={{
        'gpt-image-1': {
          imageTools: {
            edit: true,
            outpaint: true,
            backgroundRemoval: false,
            styleReference: false,
          },
        },
      }}
      models={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
      node={makeNode({
        kind: 'image',
        label: 'photo',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
      })}
      onDelete={vi.fn()}
      onOpenImageTools={onOpenImageTools}
      onUpdateData={vi.fn()}
    />
  )

  expect(
    screen.getByRole('button', { name: 'Redraw image area' })
  ).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Outpaint image' })
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove background' })).toBeNull()
  expect(
    screen.queryByRole('button', { name: 'Use style reference' })
  ).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Why some image tools are hidden' })
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Outpaint image' }))
  expect(onOpenImageTools).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'n1' }),
    'outpaint'
  )
})

test('hides the image tools when the inspector cannot open them', () => {
  render(
    <CanvasNodeInspector
      node={makeNode({
        kind: 'image',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_1' },
      })}
      onDelete={vi.fn()}
      onUpdateData={vi.fn()}
    />
  )

  expect(screen.queryByText('Image tools')).toBeNull()
})

test('hides the image tools for a node that carries no image', () => {
  render(
    <CanvasNodeInspector
      node={makeNode({
        kind: 'attachment',
        mediaType: 'video/mp4',
        ref: { sessionId: 'pgc_1', attachmentId: 'pgf_2' },
      })}
      onDelete={vi.fn()}
      onOpenImageTools={vi.fn()}
      onUpdateData={vi.fn()}
    />
  )

  expect(screen.queryByText('Image tools')).toBeNull()
})
