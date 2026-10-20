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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { Button } from '@/components/ui/button'

import { PlaygroundWelcome } from '../playground-welcome'

const originalInnerWidth = window.innerWidth

afterEach(() => {
  window.innerWidth = originalInnerWidth
})

function WelcomeHarness(props: {
  noAvailableModels?: boolean
  onStartTour?: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)} type='button'>
        Open welcome
      </Button>
      <PlaygroundWelcome
        noAvailableModels={props.noAvailableModels}
        onOpenChange={setOpen}
        onStartTour={props.onStartTour ?? vi.fn()}
        open={open}
      />
    </>
  )
}

test('desktop opens the overview with both first-visit actions', async () => {
  const user = userEvent.setup()
  const onStartTour = vi.fn()
  render(<WelcomeHarness onStartTour={onStartTour} />)

  await user.click(screen.getByRole('button', { name: 'Open welcome' }))
  const dialog = await screen.findByRole('dialog', {
    name: 'Welcome to the Playground',
  })

  expect(
    within(dialog).getByText(
      'A quick look at the conversation workspace and the canvas creation tools.'
    )
  ).toBeVisible()
  expect(
    within(dialog).getByText('Chat without leaving your workspace')
  ).toBeVisible()
  expect(dialog).toHaveAttribute('data-slot', 'dialog-content')

  await user.click(
    within(dialog).getByRole('button', { name: 'Start guided tour' })
  )
  expect(onStartTour).toHaveBeenCalledTimes(1)
})

test('Escape closes the desktop card, restores trigger focus and keeps focus trapped while open', async () => {
  const user = userEvent.setup()
  render(<WelcomeHarness />)
  const trigger = screen.getByRole('button', { name: 'Open welcome' })

  await user.click(trigger)
  const dialog = await screen.findByRole('dialog', {
    name: 'Welcome to the Playground',
  })
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true)
  )
  await user.tab()
  expect(dialog.contains(document.activeElement)).toBe(true)

  await user.keyboard('{Escape}')
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Welcome to the Playground' })
    ).toBeNull()
  )
  expect(trigger).toHaveFocus()
})

test('mobile presents the same overview as a bottom sheet', async () => {
  window.innerWidth = 375
  render(
    <PlaygroundWelcome onOpenChange={vi.fn()} onStartTour={vi.fn()} open />
  )

  const sheet = await screen.findByRole('dialog', {
    name: 'Welcome to the Playground',
  })
  expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
  expect(
    within(sheet).getByRole('button', { name: 'Explore on my own' })
  ).toBeVisible()
})

test('an inaccessible group is reported inside the welcome card', async () => {
  render(
    <PlaygroundWelcome
      noAvailableModels
      onOpenChange={vi.fn()}
      onStartTour={vi.fn()}
      open
    />
  )

  expect(
    await screen.findByText('No models are available for this group.')
  ).toBeVisible()
  expect(
    screen.getByText(
      'Ask an administrator to grant access to this group, or switch to another group.'
    )
  ).toBeVisible()
})
