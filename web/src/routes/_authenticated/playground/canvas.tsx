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
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import z from 'zod'

import { Main } from '@/components/layout'
import { CanvasWorkspace } from '@/features/canvas'
import {
  canvasGenerationPrefill,
  type CanvasArtifactTarget,
  type CanvasGenerationSearch,
} from '@/features/canvas/lib/canvas-navigation'
import { isSidebarModuleEnabled } from '@/lib/nav-modules'

const canvasInspectorViews = [
  'details',
  'assistant',
  'generate',
  'library',
  'artifacts',
  'history',
] as const

const canvasSearchSchema = z.object({
  project: z.string().optional(),
  prompt: z.string().optional(),
  generate: z.enum(['image', 'video']).optional(),
  session: z.string().optional(),
  message: z.string().optional(),
  attachment: z.string().optional(),
  artifact: z.string().optional(),
  view: z.enum(canvasInspectorViews).optional(),
})

export const Route = createFileRoute('/_authenticated/playground/canvas')({
  validateSearch: canvasSearchSchema,
  beforeLoad: () => {
    if (!isSidebarModuleEnabled('chat', 'playground')) {
      throw redirect({ to: '/dashboard' })
    }
  },
  component: CanvasPage,
})

function CanvasPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const prefill = canvasGenerationPrefill(search as CanvasGenerationSearch)
  const artifactTarget: CanvasArtifactTarget | null =
    search.artifact && search.session
      ? { sessionId: search.session, artifactId: search.artifact }
      : null
  return (
    <Main className='p-0'>
      <CanvasWorkspace
        artifactTarget={artifactTarget}
        generationPrefill={prefill}
        initialInspectorView={search.view}
        initialProjectId={search.project}
        onGenerationPrefillApplied={() => {
          void navigate({
            to: '/playground/canvas',
            search: {
              ...(search.project ? { project: search.project } : {}),
              ...(search.view ? { view: search.view } : {}),
            },
            replace: true,
          })
        }}
      />
    </Main>
  )
}
