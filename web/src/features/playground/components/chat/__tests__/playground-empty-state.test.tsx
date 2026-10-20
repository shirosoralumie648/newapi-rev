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

import { PlaygroundEmptyState } from '../playground-empty-state'

test('the default empty state keeps the starter prompts without newcomer cards', () => {
  render(<PlaygroundEmptyState onSelectPrompt={vi.fn()} />)

  expect(screen.getByRole('button', { name: 'Analyze data' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Summarize text' })).toBeVisible()
  expect(screen.queryByText('Explore the workspace')).toBeNull()
  expect(screen.queryByRole('button', { name: /Model parameters/ })).toBeNull()
})

test('newcomer feature cards open the existing panels', async () => {
  const user = userEvent.setup()
  const onOpenParameters = vi.fn()
  const onOpenPresets = vi.fn()
  const onOpenMemory = vi.fn()
  const onOpenCanvas = vi.fn()
  render(
    <PlaygroundEmptyState
      onOpenCanvas={onOpenCanvas}
      onOpenMemory={onOpenMemory}
      onOpenParameters={onOpenParameters}
      onOpenPresets={onOpenPresets}
      onSelectPrompt={vi.fn()}
      showFeatureCards
    />
  )

  expect(screen.getByText('Explore the workspace')).toBeVisible()
  await user.click(screen.getByRole('button', { name: /Model parameters/ }))
  await user.click(screen.getByRole('button', { name: /Assistant presets/ }))
  await user.click(screen.getByRole('button', { name: /Memory/ }))
  await user.click(screen.getByRole('button', { name: /Generate media/ }))

  expect(onOpenParameters).toHaveBeenCalledTimes(1)
  expect(onOpenPresets).toHaveBeenCalledTimes(1)
  expect(onOpenMemory).toHaveBeenCalledTimes(1)
  expect(onOpenCanvas).toHaveBeenCalledTimes(1)
})

test('a group without chat models shows the administrator guidance', () => {
  render(<PlaygroundEmptyState noAvailableModels onSelectPrompt={vi.fn()} />)

  expect(
    screen.getByText('No models are available for this group.')
  ).toBeVisible()
  expect(
    screen.getByText(
      'Ask an administrator to grant access to this group, or switch to another group.'
    )
  ).toBeVisible()
})
