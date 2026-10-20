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
    canAlign: false,
    canAutoLayout: false,
    canCollapse: false,
    canCopy: false,
    canDistribute: false,
    canExpand: false,
    canExportSelection: false,
    canGroup: false,
    canPaste: false,
    canRedo: false,
    canRunSelection: false,
    canSelectAll: true,
    canUndo: false,
    canUngroup: false,
    disabled: false,
    exportingPng: false,
    group: 'default',
    groups: [
      { label: 'default', value: 'default', ratio: 1 },
      { label: 'vip', value: 'vip', ratio: 1 },
    ],
    onAddNode: vi.fn(),
    onAlign: vi.fn(),
    onAutoLayout: vi.fn(),
    onCancelRun: vi.fn(),
    onCollapseSelection: vi.fn(),
    onCopy: vi.fn(),
    onDistributeHorizontal: vi.fn(),
    onDistributeVertical: vi.fn(),
    onExpandSelection: vi.fn(),
    onExport: vi.fn(),
    onExportArchive: vi.fn(),
    onExportPng: vi.fn(),
    onExportSelectionArchive: vi.fn(),
    onExportSelectionPng: vi.fn(),
    onGroupChange: vi.fn(),
    onGroupSelection: vi.fn(),
    onImportArchiveFile: vi.fn(),
    onImportFile: vi.fn(),
    onOpenTemplates: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onPaste: vi.fn(),
    onRedo: vi.fn(),
    onRunWorkflow: vi.fn(),
    onRunSelection: vi.fn(),
    onSearchNodes: vi.fn(),
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
  expect(screen.queryByRole('button', { name: 'Run selected' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Cancel run' }))
  expect(props.onCancelRun).toHaveBeenCalledTimes(1)
})

test('runs the selection only when the toolbar reports it can', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  const { rerender } = render(<CanvasToolbar {...props} />)

  expect(screen.getByRole('button', { name: 'Run selected' })).toBeDisabled()

  const selectable = { ...toolbarProps(), canRunSelection: true }
  rerender(<CanvasToolbar {...selectable} />)
  await user.click(screen.getByRole('button', { name: 'Run selected' }))
  expect(selectable.onRunSelection).toHaveBeenCalledTimes(1)
})

test('opens the node search panel from the toolbar', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Search nodes' }))
  expect(props.onSearchNodes).toHaveBeenCalledTimes(1)
})

test('opens the keyboard shortcut reference from the toolbar', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
  expect(props.onOpenShortcuts).toHaveBeenCalledTimes(1)
})

test('opens the template library from the toolbar', async () => {
  const user = userEvent.setup()
  const props = toolbarProps()
  render(<CanvasToolbar {...props} />)

  await user.click(screen.getByRole('button', { name: 'Templates' }))
  expect(props.onOpenTemplates).toHaveBeenCalledTimes(1)
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
    'Align left',
    'Align center',
    'Align right',
    'Align top',
    'Align middle',
    'Align bottom',
    'Distribute horizontally',
    'Distribute vertically',
    'Auto layout horizontally',
    'Auto layout vertically',
    'Collapse selection',
    'Expand selection',
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
    canAlign: true,
    canAutoLayout: true,
    canCollapse: true,
    canCopy: true,
    canDistribute: true,
    canExpand: true,
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
  await user.click(screen.getByRole('menuitem', { name: 'Align left' }))
  expect(props.onAlign).toHaveBeenCalledWith('left')

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(
    screen.getByRole('menuitem', { name: 'Auto layout vertically' })
  )
  expect(props.onAutoLayout).toHaveBeenCalledWith('vertical')

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Collapse selection' }))
  expect(props.onCollapseSelection).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(screen.getByRole('menuitem', { name: 'Expand selection' }))
  expect(props.onExpandSelection).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(
    screen.getByRole('menuitem', { name: 'Distribute horizontally' })
  )
  expect(props.onDistributeHorizontal).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Edit' }))
  await user.click(
    screen.getByRole('menuitem', { name: 'Distribute vertically' })
  )
  expect(props.onDistributeVertical).toHaveBeenCalledTimes(1)

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
  await user.click(screen.getByRole('menuitem', { name: 'PNG image' }))
  expect(props.onExportPng).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Export' }))
  await user.click(
    screen.getByRole('menuitem', { name: 'PNG of selected nodes' })
  )
  expect(props.onExportSelectionPng).toHaveBeenCalledTimes(1)

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
    screen.getByRole('menuitem', { name: 'PNG of selected nodes' })
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
