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
import { ViewportPortal } from '@xyflow/react'

import { cn } from '@/lib/utils'

import type { CanvasAlignmentGuide } from '../lib/canvas-align'

interface CanvasAlignmentGuidesProps {
  guides: CanvasAlignmentGuide[]
}

/**
 * Alignment lines and equal-gap measurements drawn above the nodes while a
 * selection is being dragged. The portal keeps every guide in canvas
 * coordinates, so panning and zooming move them with the nodes.
 */
export function CanvasAlignmentGuides(props: CanvasAlignmentGuidesProps) {
  if (props.guides.length === 0) return null
  return (
    <ViewportPortal>
      <div
        className='pointer-events-none absolute inset-0 z-10'
        data-testid='canvas-alignment-guides'
      >
        {props.guides.map((guide) => {
          const style =
            guide.axis === 'x'
              ? {
                  left: guide.position,
                  top: guide.start,
                  height: Math.max(guide.end - guide.start, 1),
                }
              : {
                  left: guide.start,
                  top: guide.position,
                  width: Math.max(guide.end - guide.start, 1),
                }
          const label =
            guide.kind === 'gap' && guide.gap !== undefined
              ? `${Math.round(guide.gap)} px`
              : null
          return (
            <div
              aria-hidden='true'
              className={cn(
                'absolute',
                guide.axis === 'x' ? 'w-px' : 'h-px',
                guide.kind === 'align'
                  ? 'bg-primary'
                  : 'border-primary/70 border-dashed',
                guide.kind === 'gap' && guide.axis === 'x' && 'border-l',
                guide.kind === 'gap' && guide.axis === 'y' && 'border-t'
              )}
              data-guide-kind={guide.kind}
              key={`${guide.kind}-${guide.axis}-${guide.position}-${guide.start}-${guide.end}`}
              style={style}
            >
              {label ? (
                <span
                  className='bg-primary text-primary-foreground absolute rounded px-1 py-0.5 text-[10px] leading-none whitespace-nowrap'
                  style={
                    guide.axis === 'x'
                      ? { left: 4, top: '50%' }
                      : { top: 4, left: '50%' }
                  }
                >
                  {label}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </ViewportPortal>
  )
}
