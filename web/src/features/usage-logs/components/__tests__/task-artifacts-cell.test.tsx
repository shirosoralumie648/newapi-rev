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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import type { TaskArtifact, TaskLog } from '../../types'
import { TaskArtifactsCell } from '../task-artifacts'

function taskLog(overrides: Partial<TaskLog> = {}): TaskLog {
  return {
    id: 1,
    user_id: 7,
    platform: 'alibaba',
    task_id: 'task-public',
    action: 'text_to_image',
    channel_id: 357,
    group: 'default',
    quota: 25000,
    submit_time: 1,
    status: 'SUCCESS',
    admin_info: {
      task_plugin: {
        key: 'alibaba',
        name: 'Alibaba Bailian',
        version: '1.4.0',
      },
    },
    ...overrides,
  }
}

function renderCell(
  log: TaskLog,
  onTogglePin?: (artifact: TaskArtifact) => void
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskArtifactsCell log={log} onTogglePin={onTogglePin} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('task artifacts cell', () => {
  test('given a synchronous result the gateway did not retain, a hint replaces the artifacts button', () => {
    renderCell(taskLog({ result_discarded: true }))

    expect(screen.getByText('Result not retained')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Artifacts/ })
    ).not.toBeInTheDocument()
  })

  test('given a retained successful plugin task, the artifacts button is offered', () => {
    renderCell(taskLog())

    expect(screen.getByRole('button', { name: /Artifacts/ })).toBeVisible()
    expect(screen.queryByText('Result not retained')).not.toBeInTheDocument()
  })

  test('given an unfinished task, neither the button nor the hint is shown', () => {
    renderCell(taskLog({ status: 'IN_PROGRESS', result_discarded: true }))

    expect(screen.getByText('-')).toBeVisible()
    expect(screen.queryByText('Result not retained')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Artifacts/ })
    ).not.toBeInTheDocument()
  })

  test('given a stored result, the artifacts dialog offers the keep toggle to its owner', async () => {
    const artifact: TaskArtifact = {
      key: 'output-1',
      type: 'image',
      content_url: `https://gateway.example.com/v1/tasks/task-public/artifacts/output-1/content?access=${'A'.repeat(43)}`,
      stored: true,
    }
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { artifacts: [artifact] } },
    })
    const onTogglePin = vi.fn()
    const user = userEvent.setup()
    renderCell(taskLog(), onTogglePin)

    await user.click(screen.getByRole('button', { name: /Artifacts/ }))
    const keep = await screen.findByRole('button', { name: 'Keep results' })
    await user.click(keep)

    expect(onTogglePin).toHaveBeenCalledWith(artifact)
  })

  test('given a pinned result, the keep toggle reports the active state', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: {
          artifacts: [
            {
              key: 'output-1',
              type: 'image',
              content_url: `https://gateway.example.com/v1/tasks/task-public/artifacts/output-1/content?access=${'A'.repeat(43)}`,
              stored: true,
              pinned: true,
            },
          ],
        },
      },
    })
    const user = userEvent.setup()
    renderCell(taskLog(), vi.fn())

    await user.click(screen.getByRole('button', { name: /Artifacts/ }))
    const release = await screen.findByRole('button', {
      name: 'Stop keeping results',
    })
    expect(release).toHaveAttribute('aria-pressed', 'true')
  })

  test('given a result the gateway could not store, the dialog marks it as not stored', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: {
          artifacts: [
            {
              key: 'output-1',
              type: 'image',
              content_url: `https://gateway.example.com/v1/tasks/task-public/artifacts/output-1/content?access=${'A'.repeat(43)}`,
              expired: true,
            },
          ],
        },
      },
    })
    const user = userEvent.setup()
    renderCell(taskLog(), vi.fn())

    await user.click(screen.getByRole('button', { name: /Artifacts/ }))
    await waitFor(() => expect(screen.getByText('Not stored')).toBeVisible())
    expect(
      screen.queryByRole('button', { name: 'Keep results' })
    ).not.toBeInTheDocument()
  })
})
