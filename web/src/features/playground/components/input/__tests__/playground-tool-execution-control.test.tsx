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
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { PlaygroundToolExecutionControl } from '../playground-tool-execution-control'

function renderControl(
  overrides: Partial<Parameters<typeof PlaygroundToolExecutionControl>[0]> = {}
) {
  const props = {
    enabled: true,
    maxRounds: 5,
    onEnabledChange: vi.fn(),
    onMaxRoundsChange: vi.fn(),
    ...overrides,
  }
  render(<PlaygroundToolExecutionControl {...props} />)
  return props
}

test('the account switch writes the tool loop preference', async () => {
  const user = userEvent.setup()
  const props = renderControl()

  await user.click(screen.getByRole('button', { name: 'Tool loop' }))
  await user.click(
    await screen.findByRole('switch', {
      name: 'Run supported tool calls automatically',
    })
  )

  expect(props.onEnabledChange).toHaveBeenCalledWith(false)
})

test('the round cap reports the entered value', async () => {
  const user = userEvent.setup()
  const props = renderControl()

  await user.click(screen.getByRole('button', { name: 'Tool loop' }))
  fireEvent.change(
    await screen.findByRole('spinbutton', { name: 'Maximum tool rounds' }),
    { target: { value: '8' } }
  )

  expect(props.onMaxRoundsChange).toHaveBeenCalledWith(8)
})

test('the round cap is disabled while the loop is off', async () => {
  const user = userEvent.setup()
  renderControl({ enabled: false })

  await user.click(screen.getByRole('button', { name: 'Tool loop' }))

  expect(
    await screen.findByRole('spinbutton', { name: 'Maximum tool rounds' })
  ).toBeDisabled()
})

test('discloses the manual fallback and the billed continuation', async () => {
  const user = userEvent.setup()
  renderControl()

  await user.click(screen.getByRole('button', { name: 'Tool loop' }))

  expect(
    await screen.findByText(
      'Unknown tools still wait for a manual result, and every automatic continuation is billed like a normal request.'
    )
  ).toBeVisible()
})
