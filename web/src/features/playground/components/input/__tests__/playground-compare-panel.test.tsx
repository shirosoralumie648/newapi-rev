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
import { beforeAll, describe, expect, test, vi } from 'vitest'

import type { ModelOption } from '../../../types'
import { PlaygroundCompareContent } from '../playground-compare-panel'

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', {
    'Anonymous A/B arena': 'Anonymous A/B arena',
    'Hide model names and channels for exactly two replies, then vote which one is better. This only stores your raw preference; no ranking is computed.':
      'Hide model names and channels for exactly two replies, then vote which one is better. This only stores your raw preference; no ranking is computed.',
    'Models to compare': 'Models to compare',
    'Select at least two models to compare':
      'Select at least two models to compare',
    'Select exactly two models for the anonymous arena.':
      'Select exactly two models for the anonymous arena.',
    'Sending the same message to each selected model. Every reply is billed separately.':
      'Sending the same message to each selected model. Every reply is billed separately.',
  })
})

const models: ModelOption[] = [
  { label: 'GPT-4o', value: 'gpt-4o' },
  { label: 'Claude 3', value: 'claude-3' },
  { label: 'Gemini Pro', value: 'gemini-pro' },
]

function renderPanel(
  overrides: Partial<Parameters<typeof PlaygroundCompareContent>[0]> = {}
) {
  const props = {
    anonymous: false,
    compareModels: ['gpt-4o', 'claude-3'],
    models,
    onAnonymousChange: vi.fn(),
    onCompareModelsChange: vi.fn(),
    ...overrides,
  }
  render(<PlaygroundCompareContent {...props} />)
  return props
}

describe('PlaygroundCompareContent anonymous arena', () => {
  test('toggles the anonymous mode from the comparison panel', async () => {
    const user = userEvent.setup()
    const props = renderPanel()

    const toggle = screen.getByRole('switch', {
      name: 'Anonymous A/B arena',
    })
    expect(toggle).not.toBeChecked()

    await user.click(toggle)
    expect(props.onAnonymousChange).toHaveBeenCalledWith(true)
  })

  test('enabling the arena trims a larger selection to the first two models', async () => {
    const user = userEvent.setup()
    const props = renderPanel({
      compareModels: ['gpt-4o', 'claude-3', 'gemini-pro'],
    })

    await user.click(
      screen.getByRole('switch', { name: 'Anonymous A/B arena' })
    )

    expect(props.onCompareModelsChange).toHaveBeenCalledWith([
      'gpt-4o',
      'claude-3',
    ])
    expect(props.onAnonymousChange).toHaveBeenCalledWith(true)
  })

  test('warns while the arena does not have exactly two models', () => {
    renderPanel({ anonymous: true, compareModels: ['gpt-4o'] })

    expect(
      screen.getByText('Select exactly two models for the anonymous arena.')
    ).toBeInTheDocument()
  })

  test('keeps the comparison hint while the arena has two models', () => {
    renderPanel({ anonymous: true })

    expect(
      screen.queryByText('Select exactly two models for the anonymous arena.')
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Sending the same message to each selected model. Every reply is billed separately.'
      )
    ).toBeInTheDocument()
  })
})
