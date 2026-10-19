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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import {
  createCanvasWorkflowRunBudget,
  estimateCanvasWorkflowRun,
} from '../../api'
import type { CanvasWorkflowEstimateStepInput } from '../../lib/canvas-workflow-budget'
import { CanvasRunBudgetDialog } from '../canvas-run-budget-dialog'

vi.mock('../../api', () => ({
  createCanvasWorkflowRunBudget: vi.fn(),
  estimateCanvasWorkflowRun: vi.fn(),
}))

const steps: CanvasWorkflowEstimateStepInput[] = [
  { nodeId: 'm1', kind: 'chat', model: 'gpt-4o', tokens: 4, group: 'default' },
  {
    nodeId: 't1',
    kind: 'video',
    model: 'kling-v1',
    tokens: 3,
    group: 'default',
  },
]

function renderDialog() {
  const onOpenChange = vi.fn()
  const onRun = vi.fn()
  render(
    <CanvasRunBudgetDialog
      group='default'
      onOpenChange={onOpenChange}
      onRun={onRun}
      open
      steps={steps}
    />
  )
  return { onOpenChange, onRun }
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('shows the priced steps and total, then runs without a cap', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [
      { nodeId: 'm1', quota: 125, available: true, approximate: false },
      { nodeId: 't1', quota: 2500, available: true, approximate: true },
    ],
    totalQuota: 2625,
    available: true,
  })
  const { onOpenChange, onRun } = renderDialog()

  expect(estimateCanvasWorkflowRun).toHaveBeenCalledWith('default', steps)
  expect(await screen.findByText('gpt-4o · Model call')).toBeInTheDocument()
  expect(screen.getByText('kling-v1 · Video')).toBeInTheDocument()
  expect(screen.getByText('Estimated total')).toBeInTheDocument()
  expect(
    screen.getByText(
      'Video steps are approximate: the final cost depends on the provider.'
    )
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Run workflow' }))

  await waitFor(() =>
    expect(onRun).toHaveBeenCalledWith(undefined, {
      estimateQuota: 2625,
      budgetCap: 0,
    })
  )
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(createCanvasWorkflowRunBudget).not.toHaveBeenCalled()
})

test('opens a budget cap and starts the run inside it', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [{ nodeId: 'm1', quota: 125, available: true, approximate: false }],
    totalQuota: 125,
    available: true,
  })
  vi.mocked(createCanvasWorkflowRunBudget).mockResolvedValue({
    runId: 'pgw_1',
    cap: 2500000,
    spent: 0,
    remaining: 2500000,
    status: 'active',
  })
  const { onOpenChange, onRun } = renderDialog()

  const input = await screen.findByLabelText('Run budget cap (optional)')
  await user.type(input, '5')
  expect(input).toHaveAttribute('aria-invalid', 'false')
  await user.click(screen.getByRole('button', { name: 'Run workflow' }))

  await waitFor(() => expect(onRun).toHaveBeenCalled())
  const [budget, start] = vi.mocked(onRun).mock.calls[0]
  expect(budget).toEqual({ runId: 'pgw_1' })
  expect(start).toEqual({ estimateQuota: 125, budgetCap: 2500000 })
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('warns when the cap is below the estimate but still starts the run', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [
      {
        nodeId: 'm1',
        quota: 1000000000000,
        available: true,
        approximate: false,
      },
    ],
    totalQuota: 1000000000000,
    available: true,
  })
  const { onRun } = renderDialog()

  const input = await screen.findByLabelText('Run budget cap (optional)')
  await user.type(input, '1')
  expect(
    screen.getByText(
      'The cap is below the estimate; the run may stop before the last step.'
    )
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Run workflow' }))
  await waitFor(() => expect(onRun).toHaveBeenCalled())
})

test('refuses a cap that is not a positive amount', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [{ nodeId: 'm1', quota: 125, available: true, approximate: false }],
    totalQuota: 125,
    available: true,
  })
  const { onRun } = renderDialog()

  const input = await screen.findByLabelText('Run budget cap (optional)')
  await user.type(input, '0')

  expect(
    screen.getByText('Enter an amount greater than zero.')
  ).toBeInTheDocument()
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('button', { name: 'Run workflow' })).toBeDisabled()
  expect(onRun).not.toHaveBeenCalled()
})

test('runs unpriced steps anyway and says so', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [{ nodeId: 'm1', quota: 0, available: false, approximate: false }],
    totalQuota: 0,
    available: false,
  })
  const { onRun } = renderDialog()

  expect(
    await screen.findByText(
      'Some steps have no configured price; they still run and are charged when they finish.'
    )
  ).toBeInTheDocument()
  expect(screen.getByText('Not priced')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Run workflow' }))
  await waitFor(() =>
    expect(onRun).toHaveBeenCalledWith(undefined, {
      estimateQuota: 0,
      budgetCap: 0,
    })
  )
})

test('shows the server reason when the estimate fails and retries', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockRejectedValueOnce(
    new Error('Unable to price the workflow steps.')
  )
  renderDialog()

  expect(
    await screen.findByText('Unable to price the run steps.')
  ).toBeInTheDocument()
  expect(
    screen.getByText('Unable to price the workflow steps.')
  ).toBeInTheDocument()

  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [{ nodeId: 'm1', quota: 125, available: true, approximate: false }],
    totalQuota: 125,
    available: true,
  })
  await user.click(screen.getByRole('button', { name: 'Retry' }))

  expect(await screen.findByText('Estimated total')).toBeInTheDocument()
})

test('reports a cap the server refuses and starts nothing', async () => {
  const user = userEvent.setup()
  vi.mocked(estimateCanvasWorkflowRun).mockResolvedValue({
    steps: [{ nodeId: 'm1', quota: 125, available: true, approximate: false }],
    totalQuota: 125,
    available: true,
  })
  vi.mocked(createCanvasWorkflowRunBudget).mockRejectedValue(
    new Error('Insufficient wallet quota to cover this run budget.')
  )
  const { onOpenChange, onRun } = renderDialog()

  const input = await screen.findByLabelText('Run budget cap (optional)')
  await user.type(input, '5')
  await user.click(screen.getByRole('button', { name: 'Run workflow' }))

  await waitFor(() =>
    expect(createCanvasWorkflowRunBudget).toHaveBeenCalledTimes(1)
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Run workflow' })).toBeEnabled()
  )
  expect(onRun).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalled()
})
