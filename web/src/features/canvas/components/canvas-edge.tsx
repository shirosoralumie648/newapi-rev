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
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CanvasFlowEdge } from '../types'

/**
 * The canvas connection: a bezier edge with a hover/focus delete action. The
 * action calls xyflow's `deleteElements`, so the deletion flows through the
 * editor's `onEdgesChange` and is recorded in history and autosave like any
 * other structural edit. Keyboard deletion of a selected edge stays available
 * through the editor shortcuts.
 */
export function CanvasFlowEdgeView(props: EdgeProps<CanvasFlowEdge>) {
  const { t } = useTranslation()
  const { deleteElements } = useReactFlow()
  const [pathHovered, setPathHovered] = useState(false)
  const [actionActive, setActionActive] = useState(false)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  })
  const actionVisible = pathHovered || actionActive || props.selected

  return (
    <>
      <g
        onMouseEnter={() => setPathHovered(true)}
        onMouseLeave={() => setPathHovered(false)}
      >
        <BaseEdge
          className='react-flow__edge-path'
          id={props.id}
          interactionWidth={props.interactionWidth}
          markerEnd={props.markerEnd}
          path={path}
          style={props.style}
        />
      </g>
      <EdgeLabelRenderer>
        <div
          aria-hidden={!actionVisible}
          className={`nodrag nopan absolute transition-opacity ${
            actionVisible
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0'
          }`}
          onMouseEnter={() => setActionActive(true)}
          onMouseLeave={() => setActionActive(false)}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          <button
            aria-label={t('Delete connection')}
            className='bg-card text-muted-foreground hover:text-destructive hover:border-destructive/60 focus-visible:ring-ring flex size-6 items-center justify-center rounded-full border shadow-sm transition-colors focus-visible:ring-2 focus-visible:outline-none'
            data-testid='canvas-edge-delete'
            onClick={(event) => {
              event.stopPropagation()
              void deleteElements({
                edges: [
                  {
                    id: props.id,
                    source: props.source,
                    target: props.target,
                  },
                ],
              })
            }}
            onFocus={() => setActionActive(true)}
            onBlur={() => setActionActive(false)}
            tabIndex={actionVisible ? 0 : -1}
            title={t('Delete connection')}
            type='button'
          >
            <X aria-hidden='true' className='size-3.5' />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
