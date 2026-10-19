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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { estimateCanvasWorkflowRun } from '@/features/canvas/api'

import type { ModelOption } from '../../../types'
import { PlaygroundComparisonForm } from '../playground-comparison-form'

vi.mock('@/features/canvas/api', () => ({
  estimateCanvasWorkflowRun: vi.fn(),
}))

const MODELS: ModelOption[] = [
  { label: 'GPT-4o', value: 'gpt-4o' },
  { label: 'Claude', value: 'claude' },
  { label: 'Gemini', value: 'gemini' },
]

const INITIAL_MODELS = ['gpt-4o', 'claude']

const ESTIMATE = {
  steps: [
    { nodeId: 'pgc-0-0', quota: 10, available: true, approximate: false },
    { nodeId: 'pgc-0-1', quota: 10, available: true, approximate: false },
    { nodeId: 'pgc-1-0', quota: 10, available: true, approximate: false },
    { nodeId: 'pgc-1-1', quota: 10, available: true, approximate: false },
  ],
  totalQuota: 40,
  available: true,
}

function renderForm(
  overrides: Partial<Parameters<typeof PlaygroundComparisonForm>[0]> = {}
) {
  const onStart = vi.fn().mockResolvedValue(true)
  const onStop = vi.fn()
  render(
    <PlaygroundComparisonForm
      group='default'
      initialModels={INITIAL_MODELS}
      models={MODELS}
      onStart={onStart}
      onStop={onStop}
      open
      running={false}
      {...overrides}
    />
  )
  return { onStart, onStop }
}

function setPrompts(value: string) {
  fireEvent.change(screen.getByLabelText('Prompts'), { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue(ESTIMATE)
})

describe('prompt parsing and validation', () => {
  test('refuses a malformed JSONL prompt before pricing anything', async () => {
    const user = userEvent.setup()
    const { onStart } = renderForm()
    setPrompts('{"prompt":')

    await user.click(screen.getByRole('button', { name: 'Run comparison' }))

    expect(
      await screen.findByText('Line 1 is not a valid JSONL prompt.')
    ).toBeVisible()
    expect(estimateCanvasWorkflowRun).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })

  test('refuses a run with fewer than two selected models', async () => {
    const user = userEvent.setup()
    const { onStart } = renderForm({ initialModels: ['gpt-4o'] })
    setPrompts('one prompt')

    await user.click(screen.getByRole('button', { name: 'Run comparison' }))

    expect(
      await screen.findByText('Select between 2 and 6 models.')
    ).toBeVisible()
    expect(estimateCanvasWorkflowRun).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })
})

describe('estimating and starting', () => {
  test('prices the whole matrix and starts serially with the priced total', async () => {
    const user = userEvent.setup()
    const { onStart } = renderForm()
    setPrompts('first prompt\nsecond prompt')

    await user.click(screen.getByRole('button', { name: 'Estimate cost' }))

    await waitFor(() =>
      expect(estimateCanvasWorkflowRun).toHaveBeenCalledTimes(1)
    )
    const [group, steps] = vi.mocked(estimateCanvasWorkflowRun).mock.calls[0]
    expect(group).toBe('default')
    expect(steps.map((step) => step.nodeId)).toEqual([
      'pgc-0-0',
      'pgc-0-1',
      'pgc-1-0',
      'pgc-1-1',
    ])

    await user.click(screen.getByRole('button', { name: 'Run comparison' }))

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
    expect(onStart).toHaveBeenCalledWith({
      title: undefined,
      group: 'default',
      models: ['gpt-4o', 'claude'],
      prompts: ['first prompt', 'second prompt'],
      strategy: 'serial',
      concurrency: 1,
      estimateQuota: 40,
      budgetCap: 0,
    })
  })

  test('estimates on demand, then starts with bounded concurrency, a title and a cap', async () => {
    const user = userEvent.setup()
    const { onStart } = renderForm()
    setPrompts('one prompt')
    await user.type(screen.getByLabelText('Run title (optional)'), 'Weekly run')
    await user.click(screen.getByRole('radio', { name: 'Bounded concurrency' }))
    const concurrency = screen.getByLabelText('Concurrent requests')
    await user.clear(concurrency)
    await user.type(concurrency, '3')
    await user.type(screen.getByLabelText('Run budget cap (optional)'), '5')

    await user.click(screen.getByRole('button', { name: 'Run comparison' }))

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
    const payload = onStart.mock.calls[0][0]
    expect(payload).toMatchObject({
      title: 'Weekly run',
      group: 'default',
      models: ['gpt-4o', 'claude'],
      prompts: ['one prompt'],
      strategy: 'concurrent',
      concurrency: 3,
      estimateQuota: 40,
    })
    expect(payload.budgetCap).toBeGreaterThan(0)
    expect(estimateCanvasWorkflowRun).toHaveBeenCalledTimes(1)
  })

  test('refuses a cap that is not a positive amount', async () => {
    const user = userEvent.setup()
    const { onStart } = renderForm()
    setPrompts('one prompt')
    await user.type(screen.getByLabelText('Run budget cap (optional)'), '0')

    expect(screen.getByText('Enter an amount greater than zero.')).toBeVisible()
    expect(screen.getByLabelText('Run budget cap (optional)')).toHaveAttribute(
      'aria-invalid',
      'true'
    )

    await user.click(screen.getByRole('button', { name: 'Run comparison' }))
    expect(onStart).not.toHaveBeenCalled()
  })
})

test('an active run replaces the start action with a stop action', async () => {
  const user = userEvent.setup()
  const { onStop } = renderForm({ running: true })

  expect(
    screen.queryByRole('button', { name: 'Run comparison' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Stop run' }))
  expect(onStop).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Prompts')).toBeDisabled()
})
