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

import { PlaygroundAutoReadControl } from '../playground-auto-read-control'

function renderControl(
  overrides: Partial<Parameters<typeof PlaygroundAutoReadControl>[0]> = {}
) {
  const props = {
    enabled: false,
    defaultEnabled: false,
    hasOverride: false,
    onEnabledChange: vi.fn(),
    onUseDefault: vi.fn(),
    onDefaultChange: vi.fn(),
    ...overrides,
  }
  render(<PlaygroundAutoReadControl {...props} />)
  return props
}

test('the conversation switch writes an explicit override', async () => {
  const user = userEvent.setup()
  const props = renderControl()

  await user.click(screen.getByRole('button', { name: 'Read replies aloud' }))
  await user.click(
    await screen.findByRole('switch', { name: 'Read replies aloud' })
  )

  expect(props.onEnabledChange).toHaveBeenCalledWith(true)
})

test('an explicit override can return to the account default', async () => {
  const user = userEvent.setup()
  const props = renderControl({ enabled: true, hasOverride: true })

  await user.click(screen.getByRole('button', { name: 'Read replies aloud' }))
  await user.click(
    await screen.findByRole('button', { name: 'Use account default' })
  )

  expect(props.onUseDefault).toHaveBeenCalledTimes(1)
})

test('the account default toggle applies to conversations without a choice', async () => {
  const user = userEvent.setup()
  const props = renderControl({ enabled: true })

  await user.click(screen.getByRole('button', { name: 'Read replies aloud' }))
  await user.click(
    await screen.findByRole('switch', {
      name: 'New conversations read replies aloud',
    })
  )

  expect(props.onDefaultChange).toHaveBeenCalledWith(true)
})
