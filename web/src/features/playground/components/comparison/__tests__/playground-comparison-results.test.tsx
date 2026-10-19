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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type {
  PlaygroundComparisonCell,
  PlaygroundComparisonRun,
  PlaygroundMessageCost,
} from '../../../types'
import { PlaygroundComparisonResults } from '../playground-comparison-results'

const CELLS: PlaygroundComparisonCell[] = [
  {
    promptIndex: 0,
    modelIndex: 0,
    status: 'succeeded',
    output: 'first answer',
    error: '',
    errorCode: '',
    requestId: 'r1',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyMs: 400,
  },
  {
    promptIndex: 0,
    modelIndex: 1,
    status: 'failed',
    output: '',
    error: 'quota exhausted',
    errorCode: 'insufficient_user_quota',
    requestId: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 80,
  },
  {
    promptIndex: 1,
    modelIndex: 0,
    status: 'succeeded',
    output: 'second answer',
    error: '',
    errorCode: '',
    requestId: 'r2',
    promptTokens: 20,
    completionTokens: 10,
    totalTokens: 30,
    latencyMs: 500,
  },
  {
    promptIndex: 1,
    modelIndex: 1,
    status: 'pending',
    output: '',
    error: '',
    errorCode: '',
    requestId: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
  },
]

const RUN: PlaygroundComparisonRun = {
  id: 'run-1',
  title: 'My compare',
  group: 'default',
  models: ['gpt-4o', 'claude'],
  prompts: ['same prompt', 'second prompt'],
  results: CELLS,
  status: 'completed',
  strategy: 'concurrent',
  concurrency: 2,
  estimateQuota: 5000,
  budgetCap: 0,
  baselineModel: '',
  modelCount: 2,
  promptCount: 2,
  byteSize: 1024,
  revision: 1,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
}

const COSTS = new Map<string, PlaygroundMessageCost>([
  [
    'r1',
    {
      requestId: 'r1',
      quota: 1250,
      promptTokens: 21,
      completionTokens: 9,
      totalTokens: 30,
      modelName: 'gpt-4o',
      createdAt: 1_700_000_000,
      timing: { first_token_ms: 111, total_ms: 888 },
    },
  ],
])

function renderResults(
  overrides: Partial<Parameters<typeof PlaygroundComparisonResults>[0]> = {}
) {
  const onRetry = vi.fn().mockResolvedValue(undefined)
  const onSetBaseline = vi.fn().mockResolvedValue(undefined)
  const onStartNew = vi.fn()
  const onStop = vi.fn()
  render(
    <PlaygroundComparisonResults
      costs={COSTS}
      onRetry={onRetry}
      onSetBaseline={onSetBaseline}
      onStartNew={onStartNew}
      onStop={onStop}
      retryingKey={null}
      run={RUN}
      running={false}
      {...overrides}
    />
  )
  return { onRetry, onSetBaseline, onStartNew, onStop }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:comparison'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

describe('result matrix', () => {
  test('renders settled tokens, timing and the failed cell reason', () => {
    renderResults()

    expect(screen.getByText('first answer')).toBeVisible()
    expect(screen.getByText('second answer')).toBeVisible()
    expect(screen.getByText(/quota exhausted/)).toHaveTextContent(
      'quota exhausted · insufficient_user_quota'
    )
    // The settled row's token counts win over the relay snapshot.
    expect(screen.getByText('21 / 9')).toBeVisible()
    expect(screen.getByText('20 / 10')).toBeVisible()
    expect(screen.getByText('111 ms')).toBeVisible()
    expect(screen.getByText('888 ms')).toBeVisible()
  })

  test('retries every unfinished cell and marks a baseline model', async () => {
    const user = userEvent.setup()
    const { onRetry, onSetBaseline } = renderResults()

    const retry = screen.getAllByRole('button', { name: 'Retry' })
    expect(retry).toHaveLength(2)
    await user.click(retry[0])
    expect(onRetry).toHaveBeenCalledWith(CELLS[1])

    const baseline = screen.getAllByRole('button', { name: 'Mark as baseline' })
    expect(baseline).toHaveLength(4)
    await user.click(baseline[0])
    expect(onSetBaseline).toHaveBeenCalledWith('gpt-4o')
  })

  test('stops a running run and disables retry and export meanwhile', async () => {
    const user = userEvent.setup()
    const { onStop } = renderResults({ running: true })

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Retry' })[0]).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('export', () => {
  test('downloads the matrix as CSV under the run title', async () => {
    const user = userEvent.setup()
    let downloaded = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        downloaded = this.download
      }
    )
    renderResults()

    await user.click(screen.getByRole('button', { name: 'Export' }))
    await user.click(
      await screen.findByRole('menuitem', { name: 'Export as CSV' })
    )

    expect(downloaded).toBe('My-compare.csv')
    const [blob] = vi.mocked(URL.createObjectURL).mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect((blob as Blob).type).toBe('text/csv;charset=utf-8')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:comparison')
  })
})

test('an empty result invites a first run', async () => {
  const user = userEvent.setup()
  const { onStartNew } = renderResults({ run: null })

  expect(screen.getByText('No comparison results yet')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Start a run' }))
  expect(onStartNew).toHaveBeenCalledTimes(1)
})
