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
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { TFunction } from 'i18next'
import { beforeEach, expect, test } from 'vitest'

import {
  buildCanvasTourSteps,
  buildConversationTourSteps,
  consumeCanvasTourHandoff,
  PLAYGROUND_TOUR_SELECTORS,
  requestCanvasTourHandoff,
} from '../playground-tour'

const t = ((key: string) => key) as TFunction
const playgroundRoot = path.resolve(import.meta.dirname, '../../../')

const selectorSources: Record<keyof typeof PLAYGROUND_TOUR_SELECTORS, string> =
  {
    sessions: 'components/workspace/playground-session-list.tsx',
    memory: 'components/workspace/playground-workspace.tsx',
    presets: 'components/workspace/playground-session-list.tsx',
    model: 'components/input/playground-input-controls.tsx',
    parameters: 'components/input/playground-parameter-panel.tsx',
    webSearch: 'components/input/playground-input-tools.tsx',
    composer: 'components/input/playground-input.tsx',
    canvasToolbar: '../canvas/components/canvas-toolbar.tsx',
    canvasGenerate: '../canvas/components/canvas-toolbar.tsx',
    canvasLibrary: '../canvas/components/canvas-toolbar.tsx',
    canvasArtifacts: '../canvas/components/canvas-toolbar.tsx',
    generationPanel:
      '../canvas/components/generation/canvas-generation-panel.tsx',
    artifactBrowser:
      '../canvas/components/artifacts/canvas-artifact-browser.tsx',
    assetLibrary: '../canvas/components/assets/canvas-asset-library.tsx',
  }

beforeEach(() => {
  window.sessionStorage.clear()
})

for (const [name, selector] of Object.entries(PLAYGROUND_TOUR_SELECTORS)) {
  test(`${name} tour anchor is rendered by its panel`, () => {
    const source = readFileSync(
      path.resolve(
        playgroundRoot,
        selectorSources[name as keyof typeof selectorSources]
      ),
      'utf8'
    )
    const attribute = selector.match(/^\[data-tour="(.+)"\]$/)?.[1]

    expect(attribute).toBeTruthy()
    expect(source).toContain('data-tour')
    expect(source).toContain(`'${attribute}'`)
  })
}

test('the desktop conversation tour visits the workspace and composer anchors', () => {
  expect(
    buildConversationTourSteps(t, false)
      .map((step) => step.element)
      .filter(Boolean)
  ).toEqual([
    PLAYGROUND_TOUR_SELECTORS.sessions,
    PLAYGROUND_TOUR_SELECTORS.model,
    PLAYGROUND_TOUR_SELECTORS.parameters,
    PLAYGROUND_TOUR_SELECTORS.webSearch,
    PLAYGROUND_TOUR_SELECTORS.composer,
    PLAYGROUND_TOUR_SELECTORS.memory,
    PLAYGROUND_TOUR_SELECTORS.presets,
  ])
})

test('the compact conversation tour keeps the main anchors before the canvas handoff', () => {
  const steps = buildConversationTourSteps(t, true)

  expect(steps.map((step) => step.element).filter(Boolean)).toEqual([
    PLAYGROUND_TOUR_SELECTORS.sessions,
    PLAYGROUND_TOUR_SELECTORS.model,
    PLAYGROUND_TOUR_SELECTORS.composer,
  ])
  expect(steps.at(-1)?.element).toBeUndefined()
  expect(steps.at(-1)?.popover?.doneBtnText).toBe('Open the canvas')
})

test('the canvas tour follows the board tools and shortens on mobile', () => {
  expect(buildCanvasTourSteps(t, false).map((step) => step.element)).toEqual([
    PLAYGROUND_TOUR_SELECTORS.canvasToolbar,
    PLAYGROUND_TOUR_SELECTORS.canvasGenerate,
    PLAYGROUND_TOUR_SELECTORS.canvasArtifacts,
    PLAYGROUND_TOUR_SELECTORS.canvasLibrary,
  ])
  expect(buildCanvasTourSteps(t, true).map((step) => step.element)).toEqual([
    PLAYGROUND_TOUR_SELECTORS.canvasToolbar,
    PLAYGROUND_TOUR_SELECTORS.canvasGenerate,
    PLAYGROUND_TOUR_SELECTORS.canvasLibrary,
  ])
})

test('the canvas handoff is consumed exactly once', () => {
  expect(consumeCanvasTourHandoff()).toBe(false)

  requestCanvasTourHandoff()
  expect(consumeCanvasTourHandoff()).toBe(true)
  expect(consumeCanvasTourHandoff()).toBe(false)
})
