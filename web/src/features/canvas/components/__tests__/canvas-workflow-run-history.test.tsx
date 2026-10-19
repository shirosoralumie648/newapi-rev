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
import { toast } from 'sonner'
import { beforeEach, expect, test, vi } from 'vitest'

import {
  deleteCanvasWorkflowRun,
  getCanvasWorkflowRun,
  listCanvasWorkflowRuns,
} from '../../api'
import type {
  CanvasWorkflowRun,
  CanvasWorkflowRunNodeRecord,
  CanvasWorkflowRunSummary,
} from '../../types'
import { CanvasWorkflowRunHistory } from '../canvas-workflow-run-history'

vi.mock('../../api', () => ({
  deleteCanvasWorkflowRun: vi.fn(),
  getCanvasWorkflowRun: vi.fn(),
  listCanvasWorkflowRuns: vi.fn(),
}))

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  })
  return { toast }
})

const createdAt = 1_760_000_000

const summary: CanvasWorkflowRunSummary = {
  id: 'run-2',
  canvasId: 'c1',
  sessionId: '',
  workflowRevision: 3,
  status: 'completed',
  nodeCount: 2,
  cacheHits: 1,
  totalQuota: 1234,
  promptTokens: 10,
  completionTokens: 20,
  totalTokens: 30,
  durationMs: 2500,
  estimateQuota: 2000,
  budgetCap: 5000,
  byteSize: 800,
  revision: 2,
  createdAt: createdAt * 1000,
  updatedAt: createdAt * 1000 + 2500,
}

const node = (
  overrides: Partial<CanvasWorkflowRunNodeRecord>
): CanvasWorkflowRunNodeRecord => ({
  nodeId: 'm1',
  kind: 'model',
  model: 'gpt-4o',
  group: 'default',
  status: 'succeeded',
  fingerprint: 'fp-1',
  cacheHit: false,
  output: '',
  taskId: '',
  artifactKeys: [],
  resultCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  quota: 0,
  durationMs: 800,
  error: '',
  startedAt: createdAt,
  finishedAt: createdAt + 1,
  ...overrides,
})

const run: CanvasWorkflowRun = {
  ...summary,
  nodes: [
    node({ cacheHit: true, output: 'The cached answer' }),
    node({
      nodeId: 'task-1',
      kind: 'task',
      model: 'kling-v1',
      status: 'failed',
      fingerprint: 'fp-2',
      durationMs: 1700,
      error: 'Upstream timeout',
    }),
  ],
}

type HistoryProps = {
  active?: boolean
  lastRunId?: string | null
  refreshKey?: number
  running?: boolean
  onRestoreCache?: (value: CanvasWorkflowRun) => void
  onRerun?: (value: CanvasWorkflowRun) => void
}

function renderHistory(props: HistoryProps = {}) {
  return render(
    <CanvasWorkflowRunHistory
      active={props.active ?? true}
      canvasId='c1'
      disabled={false}
      lastRunId={props.lastRunId ?? null}
      onRerun={props.onRerun ?? vi.fn()}
      onRestoreCache={props.onRestoreCache ?? vi.fn()}
      refreshKey={props.refreshKey ?? 0}
      running={props.running ?? false}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listCanvasWorkflowRuns).mockResolvedValue([summary])
  vi.mocked(getCanvasWorkflowRun).mockResolvedValue(run)
  vi.mocked(deleteCanvasWorkflowRun).mockResolvedValue(undefined)
})

test('lists stored runs and shows the node waterfall of the selected run', async () => {
  const user = userEvent.setup()
  renderHistory()

  expect(await screen.findByText('Revision 3')).toBeVisible()
  expect(screen.getByText('Completed')).toBeVisible()
  expect(screen.getByText('2 steps')).toBeVisible()
  expect(screen.getByText('1 cached')).toBeVisible()

  await user.click(screen.getByRole('button', { name: /Revision 3/ }))

  expect(await screen.findByText('Step waterfall')).toBeVisible()
  expect(screen.getByText('Model call')).toBeVisible()
  expect(screen.getByText('Generation')).toBeVisible()
  expect(screen.getByText('Cached')).toBeVisible()
  expect(screen.getByText('The cached answer')).toBeVisible()
  expect(screen.getByText('Upstream timeout')).toBeVisible()
  expect(screen.getByText('Succeeded')).toBeVisible()
  expect(screen.getByText('Failed')).toBeVisible()
  expect(screen.getByText('Cache hits')).toBeVisible()
  expect(screen.getByText('Total cost')).toBeVisible()
})

test('reuses a historical run as the next cache baseline', async () => {
  const user = userEvent.setup()
  const onRestoreCache = vi.fn()
  renderHistory({ onRestoreCache })

  await user.click(await screen.findByRole('button', { name: /Revision 3/ }))
  await user.click(
    await screen.findByRole('button', { name: 'Reuse this run' })
  )

  expect(onRestoreCache).toHaveBeenCalledWith(run)
  expect(toast.success).toHaveBeenCalledWith(
    'The next run will reuse the successful steps of this run.'
  )
})

test('shows the node diff after a forced rerun finishes', async () => {
  const user = userEvent.setup()
  const onRerun = vi.fn()
  const view = renderHistory({ lastRunId: 'run-2', onRerun })

  await user.click(await screen.findByRole('button', { name: /Revision 3/ }))
  await user.click(
    await screen.findByRole('button', { name: 'Rerun with fresh outputs' })
  )
  expect(onRerun).toHaveBeenCalledWith(run)

  vi.mocked(getCanvasWorkflowRun).mockResolvedValueOnce({
    ...run,
    id: 'run-3',
    revision: 1,
    nodes: [
      node({ cacheHit: false, output: 'A fresh answer' }),
      node({
        nodeId: 'task-1',
        kind: 'task',
        model: 'kling-v1',
        status: 'failed',
        fingerprint: 'fp-2',
        durationMs: 1700,
        error: 'Upstream timeout',
      }),
    ],
  })

  view.rerender(
    <CanvasWorkflowRunHistory
      active
      canvasId='c1'
      disabled={false}
      lastRunId='run-2'
      onRerun={onRerun}
      onRestoreCache={vi.fn()}
      refreshKey={0}
      running
    />
  )
  view.rerender(
    <CanvasWorkflowRunHistory
      active
      canvasId='c1'
      disabled={false}
      lastRunId='run-3'
      onRerun={onRerun}
      onRestoreCache={vi.fn()}
      refreshKey={0}
      running={false}
    />
  )

  expect(await screen.findByText('Changes in the rerun')).toBeVisible()
  expect(screen.getByText('1 changed steps')).toBeVisible()
  expect(screen.getByText('Output changed')).toBeVisible()
})

test('deletes the selected run after confirmation', async () => {
  const user = userEvent.setup()
  renderHistory()

  await user.click(await screen.findByRole('button', { name: /Revision 3/ }))
  await user.click(await screen.findByRole('button', { name: 'Delete' }))

  const confirmation = await screen.findByRole('alertdialog')
  expect(confirmation).toHaveTextContent('Delete this run?')
  await user.click(within(confirmation).getByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(deleteCanvasWorkflowRun).toHaveBeenCalledWith('run-2')
  )
  expect(toast.success).toHaveBeenCalledWith('Run deleted from history.')
  expect(await screen.findByText('No workflow runs yet')).toBeVisible()
})

test('shows the empty state when the canvas has no stored runs', async () => {
  vi.mocked(listCanvasWorkflowRuns).mockResolvedValue([])

  renderHistory()

  expect(await screen.findByText('No workflow runs yet')).toBeVisible()
})
