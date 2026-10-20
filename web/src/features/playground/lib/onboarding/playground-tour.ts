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
import type { DriveStep } from 'driver.js'
import type { TFunction } from 'i18next'

/**
 * Stable anchors of the two onboarding tours. The panel roots are kept for
 * tests and for future steps even when the current tour highlights the
 * toolbar entry that opens the panel.
 */
export const PLAYGROUND_TOUR_SELECTORS = {
  sessions: '[data-tour="workspace-sessions"]',
  memory: '[data-tour="workspace-memory"]',
  presets: '[data-tour="workspace-presets"]',
  model: '[data-tour="composer-model"]',
  parameters: '[data-tour="composer-parameters"]',
  webSearch: '[data-tour="composer-web-search"]',
  composer: '[data-tour="composer"]',
  canvasToolbar: '[data-tour="canvas-toolbar"]',
  canvasGenerate: '[data-tour="canvas-generate"]',
  canvasLibrary: '[data-tour="canvas-library"]',
  canvasArtifacts: '[data-tour="canvas-artifacts"]',
  generationPanel: '[data-tour="canvas-generation-panel"]',
  artifactBrowser: '[data-tour="canvas-artifact-browser"]',
  assetLibrary: '[data-tour="canvas-asset-library"]',
} as const

const CANVAS_TOUR_HANDOFF_KEY = 'playground_onboarding_canvas_tour'

/**
 * The conversation tour ends by offering the canvas tour. The target route is
 * a different page, so the request crosses the navigation through tab-scoped
 * storage and is consumed exactly once by the canvas workspace.
 */
export function requestCanvasTourHandoff(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(CANVAS_TOUR_HANDOFF_KEY, '1')
  } catch {
    // A blocked session store only skips the follow-up tour.
  }
}

export function consumeCanvasTourHandoff(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.sessionStorage.getItem(CANVAS_TOUR_HANDOFF_KEY) !== '1') {
      return false
    }
    window.sessionStorage.removeItem(CANVAS_TOUR_HANDOFF_KEY)
    return true
  } catch {
    return false
  }
}

export function buildConversationTourSteps(
  t: TFunction,
  compact: boolean
): DriveStep[] {
  const sessions: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.sessions,
    popover: {
      title: t('Your conversations'),
      description: t(
        'Switch, search, pin or tag conversations here. Deleted conversations stay recoverable in the trash.'
      ),
      side: 'right',
      align: 'start',
    },
  }
  const model: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.model,
    popover: {
      title: t('Model and group'),
      description: t(
        'Pick a model and group. The list shows pricing and capabilities before you send.'
      ),
      side: 'top',
    },
  }
  const composer: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.composer,
    popover: {
      title: t('Message composer'),
      description: t(
        'Write, attach files and send here. Your draft stays with the conversation.'
      ),
      side: 'top',
    },
  }
  const canvas: DriveStep = {
    popover: {
      title: t('Creation lives on the canvas'),
      description: t(
        'Media generation, artifacts and the asset library live in the canvas editor. Finish this tour there.'
      ),
      doneBtnText: t('Open the canvas'),
    },
  }

  if (compact) return [sessions, model, composer, canvas]

  return [
    sessions,
    model,
    {
      element: PLAYGROUND_TOUR_SELECTORS.parameters,
      popover: {
        title: t('Parameter panel'),
        description: t(
          'Open it to control temperature, token limits and other sampling options for the next request.'
        ),
        side: 'top',
      },
    },
    {
      element: PLAYGROUND_TOUR_SELECTORS.webSearch,
      popover: {
        title: t('Web search'),
        description: t(
          'Turn on web search for one turn so the reply can cite fresh results.'
        ),
        side: 'top',
      },
    },
    composer,
    {
      element: PLAYGROUND_TOUR_SELECTORS.memory,
      popover: {
        title: t('Memory'),
        description: t(
          'Keep durable notes the assistant can reuse across conversations.'
        ),
        side: 'bottom',
      },
    },
    {
      element: PLAYGROUND_TOUR_SELECTORS.presets,
      popover: {
        title: t('Assistant presets'),
        description: t(
          'Start from a saved assistant with its own model, prompt and parameters.'
        ),
        side: 'right',
      },
    },
    canvas,
  ]
}

export function buildCanvasTourSteps(
  t: TFunction,
  compact: boolean
): DriveStep[] {
  const toolbar: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.canvasToolbar,
    popover: {
      title: t('Canvas toolbar'),
      description: t(
        'Add nodes, run workflows, align selections and import or export the board.'
      ),
      side: 'bottom',
      align: 'start',
    },
  }
  const generate: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.canvasGenerate,
    popover: {
      title: t('Generation panel'),
      description: t(
        "Open Generate to compose image and video batches. Tasks use your account's normal relay and billing."
      ),
      side: 'bottom',
    },
  }
  const library: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.canvasLibrary,
    popover: {
      title: t('Asset library'),
      description: t(
        'Open Library to reuse attachments, artifacts and generated results.'
      ),
      side: 'bottom',
    },
  }
  const artifacts: DriveStep = {
    element: PLAYGROUND_TOUR_SELECTORS.canvasArtifacts,
    popover: {
      title: t('Artifact browser'),
      description: t(
        'Open Artifacts to browse, preview and add saved artifacts to this canvas.'
      ),
      side: 'bottom',
    },
  }

  if (compact) return [toolbar, generate, library]
  return [toolbar, generate, artifacts, library]
}
