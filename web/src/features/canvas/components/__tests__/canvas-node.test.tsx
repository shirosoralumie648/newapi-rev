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
import { ReactFlowProvider } from '@xyflow/react'
import { expect, test } from 'vitest'

import type { CanvasNodeData } from '../../types'
import { CanvasFlowNodeView } from '../canvas-node'

function renderNode(data: CanvasNodeData) {
  const props = {
    id: 'n1',
    data,
    selected: false,
    type: 'message',
    zIndex: 0,
    isConnectable: true,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<typeof CanvasFlowNodeView>[0]

  return render(
    <ReactFlowProvider>
      <CanvasFlowNodeView {...props} />
    </ReactFlowProvider>
  )
}

test('marks a deleted source while keeping the saved snapshot visible', () => {
  renderNode({
    kind: 'message',
    text: 'snapshot text',
    snapshot: {
      sessionId: 'pgs_1',
      messageKey: 'm1',
      role: 'assistant',
      text: 'snapshot text',
    },
    ref: { sessionId: 'pgs_1', messageKey: 'm1' },
    sourceDeleted: true,
  })

  expect(screen.getByText('Source deleted')).toBeInTheDocument()
  expect(screen.getByText('snapshot text')).toBeInTheDocument()
  expect(
    screen.getByText(
      'The original was deleted. A saved snapshot is shown instead.'
    )
  ).toBeInTheDocument()
})

test('does not mark a node whose source still resolves', () => {
  renderNode({
    kind: 'message',
    text: 'live',
    ref: { sessionId: 'pgs_1', messageKey: 'm1' },
  })

  expect(screen.queryByText('Source deleted')).not.toBeInTheDocument()
})
