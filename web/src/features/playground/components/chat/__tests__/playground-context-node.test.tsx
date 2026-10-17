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
import i18next from 'i18next'
import { beforeAll, expect, test, vi } from 'vitest'

import type { PlaygroundContextSummary } from '../../../types'
import { PlaygroundContextNode } from '../playground-context-node'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const summary: PlaygroundContextSummary = {
  id: 'pgc_1',
  content: 'Summary of the first exchange.',
  throughMessageKey: 'a1',
  messageCount: 2,
  model: 'summary-model',
  createdAt: 1,
}

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    'Compressed {{messages}} earlier messages':
      'Compressed {{messages}} earlier messages',
    'Context summary': 'Context summary',
    'Generated with {{model}}': 'Generated with {{model}}',
    'Remove summary': 'Remove summary',
  })
})

test('the compression node expands to its text and reports removal', async () => {
  const user = userEvent.setup()
  const onRemove = vi.fn()
  render(<PlaygroundContextNode onRemove={onRemove} summary={summary} />)

  const trigger = screen.getByRole('button', {
    name: 'Compressed 2 earlier messages',
  })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(
    screen.queryByText('Summary of the first exchange.')
  ).not.toBeInTheDocument()

  await user.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(
    await screen.findByText('Summary of the first exchange.')
  ).toBeInTheDocument()
  expect(screen.getByText('Generated with summary-model')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Remove summary' }))
  expect(onRemove).toHaveBeenCalledTimes(1)
})

test('the node offers no removal action when the caller cannot undo it', () => {
  render(<PlaygroundContextNode summary={summary} />)

  expect(
    screen.queryByRole('button', { name: 'Remove summary' })
  ).not.toBeInTheDocument()
})
