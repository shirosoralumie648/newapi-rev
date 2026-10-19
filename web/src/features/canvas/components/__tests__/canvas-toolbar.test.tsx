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
    inspectorView: 'details' as const,
    canCopy: false,
    canExportSelection: false,
    canGroup: false,
    canPaste: false,
    canRedo: false,
    canSelectAll: true,
    canUndo: false,
    canUngroup: false,
    disabled: false,
    group: 'default',
    groups: [
      { label: 'default', value: 'default', ratio: 1 },
      { label: 'vip', value: 'vip', ratio: 1 },
    ],
    onAddNode: vi.fn(),
    onCancelRun: vi.fn(),
    onCopy: vi.fn(),
    onExport: vi.fn(),
    onExportArchive: vi.fn(),
    onExportSelectionArchive: vi.fn(),
    onGroupChange: vi.fn(),
    onGroupSelection: vi.fn(),
    onImportArchiveFile: vi.fn(),
    onImportFile: vi.fn(),
    onPaste: vi.fn(),
    onRedo: vi.fn(),
    onRunWorkflow: vi.fn(),
    onSelectAll: vi.fn(),
    onToggleInspectorView: vi.fn(),
    onUndo: vi.fn(),
    onUngroupSelection: vi.fn(),
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

test('disables edit actions that do not apply to the selection', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Edit' }))

  for (const name of [
    'Copy',
    'Paste',
    'Group selection',
    'Ungroup selection',
  ]) {
    expect(screen.getByRole('menuitem', { name })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  }
  expect(
    screen.getByRole('menuitem', { name: 'Select all' })
  ).not.toHaveAttribute('aria-disabled', 'true')
})

test('runs the edit actions the selection allows', async () => {
  const user = userEvent.setup()
  const props = {
    ...toolbarProps(),
    canCopy: true,
    canGroup: true,
    canPaste: true,
    canRedo: true,
    canUngroup: true,
    canUndo: true,
  }
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Copy' }))
  expect(props.onCopy).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Paste' }))
  expect(props.onPaste).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Group selection' }))
  expect(props.onGroupSelection).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Ungroup selection' }))
  expect(props.onUngroupSelection).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Select all' }))
  expect(props.onSelectAll).toHaveBeenCalledTimes(1)
})

test('toggles the assistant view and reports its pressed state', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  const { rerender } = render(<CanvasToolbar {...props} />)

  const toggle = screen.getByRole('button', { name: 'Assistant' })
  expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await user.click(toggle)
  expect(props.onToggleInspectorView).toHaveBeenCalledWith('assistant')

  rerender(<CanvasToolbar {...props} inspectorView='assistant' />)
  expect(screen.getByRole('button', { name: 'Assistant' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
})

test('exports the document as JSON, an archive or a selection archive', async () => {
  const user = userEvent.setup()
  const props = { ...toolbarProps(), canExportSelection: true }
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Export' }))
  await user.click(screen.getByRole('menuitem', { name: 'JSON file' }))
  expect(props.onExport).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Export' }))
  await user.click(screen.getByRole('menuitem', { name: 'ZIP archive' }))
  expect(props.onExportArchive).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Export' }))
  await user.click(
    screen.getByRole('menuitem', { name: 'ZIP archive of selected nodes' })
  )
  expect(props.onExportSelectionArchive).toHaveBeenCalledTimes(1)
})

test('disables the selection archive while nothing is selected', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Export' }))
  expect(
    screen.getByRole('menuitem', { name: 'ZIP archive of selected nodes' })
  ).toHaveAttribute('aria-disabled', 'true')
  expect(
    screen.getByRole('menuitem', { name: 'ZIP archive' })
  ).not.toHaveAttribute('aria-disabled', 'true')
})

test('imports the chosen JSON or archive file', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  const json = new File(['{"version":1}'], 'canvas.json', {
    type: 'application/json',
  })
  await user.upload(screen.getByLabelText('Import canvas JSON file'), json)
  expect(props.onImportFile).toHaveBeenCalledWith(json)

  const archive = new File(['zip'], 'canvas.zip', { type: 'application/zip' })
  await user.upload(
    screen.getByLabelText('Import canvas archive file'),
    archive
  )
  expect(props.onImportArchiveFile).toHaveBeenCalledWith(archive)
})
