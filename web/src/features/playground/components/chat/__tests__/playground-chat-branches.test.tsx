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
import { describe, expect, test, vi } from 'vitest'

import type { Message } from '../../../types'
import { PlaygroundChat } from '../playground-chat'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const branchedMessage: Message = {
  key: 'assistant-1',
  from: 'assistant',
  status: 'complete',
  isContentComplete: true,
  activeVersionIndex: 1,
  versions: [
    { id: 'a1', content: 'Original answer' },
    { id: 'a2', content: 'Regenerated answer' },
  ],
}

describe('PlaygroundChat branch history', () => {
  test('renders the branch selector for a message with multiple versions', () => {
    render(<PlaygroundChat messages={[branchedMessage]} />)

    expect(screen.getByText('Regenerated answer')).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  test('switching branches reports the selected version index', async () => {
    const user = userEvent.setup()
    const onSelectVersion = vi.fn()

    render(
      <PlaygroundChat
        messages={[branchedMessage]}
        onSelectVersion={onSelectVersion}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Previous branch' }))

    expect(onSelectVersion).toHaveBeenCalledWith(branchedMessage, 0)
  })

  test('hides the branch selector for a single-version message', () => {
    render(
      <PlaygroundChat
        messages={[
          {
            key: 'assistant-2',
            from: 'assistant',
            status: 'complete',
            versions: [{ id: 'b1', content: 'Only answer' }],
          },
        ]}
      />
    )

    expect(screen.getByText('Only answer')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Previous branch' })
    ).not.toBeInTheDocument()
  })
})
