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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { CanvasFlowNode } from '../../types'
import { CanvasNodeSearchView } from '../canvas-node-search'

// jsdom lacks the Web Animations API the dialog's scroll area waits on.
Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

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

const nodes = [
  searchNode('n1', 'prompt', {
    label: 'Hero',
    text: 'a red fox',
    tags: ['animal'],
  }),
  searchNode('n2', 'model', { workflow: { output: 'fox answer' } }),
  searchNode('n3', 'note', { text: 'unrelated' }),
]

// The node type <select> also exposes native <option> elements with the same
// labels as result items, so result queries are scoped to the command list.
function results() {
  return within(screen.getByRole('listbox'))
}

function renderSearch(onSelectNode = vi.fn()) {
  const onOpenChange = vi.fn()
  render(
    <CanvasNodeSearchView
      nodes={nodes}
      onOpenChange={onOpenChange}
      onSelectNode={onSelectNode}
      open
    />
  )
  return { onOpenChange, onSelectNode }
}

test('filters the visible results by name, tag and content as the query changes', async () => {
  const user = userEvent.setup()
  renderSearch()

  const input = screen.getByPlaceholderText('Search nodes...')
  await user.type(input, 'hero')
  expect(results().getByRole('option', { name: /Hero/ })).toBeInTheDocument()
  expect(results().queryByRole('option', { name: /unrelated/ })).toBeNull()

  await user.clear(input)
  await user.type(input, 'animal')
  expect(results().getByRole('option', { name: /Hero/ })).toBeInTheDocument()

  await user.clear(input)
  await user.type(input, 'fox')
  expect(results().getByRole('option', { name: /Hero/ })).toBeInTheDocument()
  expect(
    results().getByRole('option', { name: /Model call/ })
  ).toBeInTheDocument()
})

test('filters the results by node type', async () => {
  const user = userEvent.setup()
  renderSearch()

  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Node type' }),
    'model'
  )

  expect(
    results().getByRole('option', { name: /Model call/ })
  ).toBeInTheDocument()
  expect(results().queryByRole('option', { name: /Hero/ })).toBeNull()
})

test('reports the chosen node so the canvas can select and center it', async () => {
  const user = userEvent.setup()
  const { onSelectNode } = renderSearch()

  await user.click(results().getByRole('option', { name: /Model call/ }))
  expect(onSelectNode).toHaveBeenCalledWith('n2')
})

test('shows the empty state when nothing matches', async () => {
  const user = userEvent.setup()
  renderSearch()

  await user.type(screen.getByPlaceholderText('Search nodes...'), 'zzz')
  expect(screen.getByText('No matching nodes.')).toBeInTheDocument()
})
