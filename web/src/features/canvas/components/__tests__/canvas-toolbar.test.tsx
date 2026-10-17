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

import type { CanvasWorkflowRunPhase } from '../../hooks/use-canvas-workflow-runner'
import { CanvasToolbar } from '../canvas-toolbar'

function toolbarProps(runPhase: CanvasWorkflowRunPhase = 'idle') {
  return {
    canRedo: false,
    canUndo: false,
    disabled: false,
    group: 'default',
    groups: [
      { label: 'default', value: 'default', ratio: 1 },
      { label: 'vip', value: 'vip', ratio: 1 },
    ],
    onAddNode: vi.fn(),
    onCancelRun: vi.fn(),
    onExport: vi.fn(),
    onGroupChange: vi.fn(),
    onImportFile: vi.fn(),
    onRedo: vi.fn(),
    onRunWorkflow: vi.fn(),
    onUndo: vi.fn(),
    runPhase,
  }
}

test('starts a workflow run and reports a group change', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Run workflow' }))
  expect(props.onRunWorkflow).toHaveBeenCalledTimes(1)

  await user.selectOptions(screen.getByLabelText('Group'), 'vip')
  expect(props.onGroupChange).toHaveBeenCalledWith('vip')
})

test('offers cancel instead of a second run while the workflow is running', async () => {
  const user = userEvent.setup()
  const props = toolbarProps('running')
  render(<CanvasToolbar {...props} />)

  expect(screen.queryByRole('button', { name: 'Run workflow' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Cancel run' }))
  expect(props.onCancelRun).toHaveBeenCalledTimes(1)
})
