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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import {
  createGlobalCanvasTemplate,
  getCanvasTemplate,
  listCanvasTemplateMarket,
  listCanvasTemplates,
  listGlobalCanvasTemplates,
} from '../../api'
import type { CanvasTemplateDetail, CanvasTemplateSummary } from '../../types'
import { CanvasTemplateLibraryDialog } from '../canvas-template-library-dialog'

vi.mock('../../api', () => ({
  copyCanvasTemplateFromMarket: vi.fn(),
  createCanvasTemplate: vi.fn(),
  createGlobalCanvasTemplate: vi.fn(),
  deleteCanvasTemplate: vi.fn(),
  deleteGlobalCanvasTemplate: vi.fn(),
  exportCanvasTemplate: vi.fn(),
  getCanvasTemplate: vi.fn(),
  importCanvasTemplate: vi.fn(),
  listCanvasTemplateMarket: vi.fn(),
  listCanvasTemplates: vi.fn(),
  listGlobalCanvasTemplates: vi.fn(),
  updateCanvasTemplate: vi.fn(),
  updateGlobalCanvasTemplate: vi.fn(),
}))

const summary: CanvasTemplateSummary = {
  id: 'pgct_1',
  name: 'Translation chain',
  description: 'Translate a text.',
  category: 'translation',
  visibility: 'private',
  inlineAssets: false,
  nodeCount: 2,
  edgeCount: 1,
  documentBytes: 128,
  assetCount: 0,
  assetBytes: 0,
  createdAt: 0,
  updatedAt: 0,
}

const detail: CanvasTemplateDetail = {
  ...summary,
  document: {
    nodes: [
      {
        id: 'prompt',
        type: 'prompt',
        position: { x: 0, y: 0 },
        data: { kind: 'prompt', text: 'Translate.' },
      },
    ],
    edges: [],
  },
  assets: [],
}

function renderDialog() {
  const onOpenChange = vi.fn()
  const onApplyToCurrent = vi.fn().mockResolvedValue({ droppedRefs: 0 })
  const onCreateFromTemplate = vi.fn().mockResolvedValue({ droppedRefs: 0 })
  const onFlush = vi.fn().mockResolvedValue(undefined)
  render(
    <CanvasTemplateLibraryDialog
      canvasId='pgc_canvas'
      canvasTitle='Board'
      onApplyToCurrent={onApplyToCurrent}
      onCreateFromTemplate={onCreateFromTemplate}
      onFlush={onFlush}
      onOpenChange={onOpenChange}
      open
    />
  )
  return { onApplyToCurrent, onCreateFromTemplate, onFlush, onOpenChange }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.getState().auth.reset()
  useAuthStore.getState().auth.setUser({
    id: 1,
    username: 'admin',
    role: ROLE.ADMIN,
  })
  vi.mocked(listCanvasTemplates).mockResolvedValue([summary])
  vi.mocked(listCanvasTemplateMarket).mockResolvedValue([])
  vi.mocked(listGlobalCanvasTemplates).mockResolvedValue([])
  vi.mocked(getCanvasTemplate).mockResolvedValue(detail)
})

afterEach(() => {
  useAuthStore.getState().auth.reset()
})

test('loads the personal library and applies a template to the current canvas', async () => {
  const user = userEvent.setup()
  const callbacks = renderDialog()

  expect(await screen.findByText('Translation chain')).toBeVisible()
  expect(listCanvasTemplates).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Apply' }))

  await waitFor(() =>
    expect(callbacks.onApplyToCurrent).toHaveBeenCalledWith(detail)
  )
  expect(getCanvasTemplate).toHaveBeenCalledWith('pgct_1')
  expect(callbacks.onOpenChange).toHaveBeenCalledWith(false)
})

test('an administrator saves the current canvas as a global template', async () => {
  const user = userEvent.setup()
  const callbacks = renderDialog()
  vi.mocked(createGlobalCanvasTemplate).mockResolvedValue({
    template: { ...summary, visibility: 'global' },
    assetsInlined: 0,
    resourcesMissing: 0,
    referencesDropped: 0,
  })

  await user.click(await screen.findByRole('tab', { name: 'Manage global' }))
  expect(
    await screen.findByText('Save current canvas as a global template')
  ).toBeVisible()
  const name = screen.getByLabelText('Template name')
  await user.clear(name)
  await user.type(name, 'Shared chain')
  await user.click(
    screen.getByRole('button', { name: 'Save as global template' })
  )

  await waitFor(() =>
    expect(createGlobalCanvasTemplate).toHaveBeenCalledWith({
      canvasId: 'pgc_canvas',
      name: 'Shared chain',
      description: undefined,
      category: undefined,
      inlineAssets: false,
    })
  )
  expect(callbacks.onFlush).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(listGlobalCanvasTemplates).toHaveBeenCalled())
})
