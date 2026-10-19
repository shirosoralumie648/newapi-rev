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
import { useReactFlow, useViewport } from '@xyflow/react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

export interface CanvasViewportControlsViewProps {
  zoom: number
  disabled?: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFitView: () => void
  onResetZoom: () => void
}

/**
 * Zoom, fit and 100% reset controls. The view is separate from the xyflow hook
 * wiring so its button contract stays testable without a flow instance.
 */
export function CanvasViewportControlsView(
  props: CanvasViewportControlsViewProps
) {
  const { t } = useTranslation()
  return (
    <div
      aria-label={t('Canvas view controls')}
      className='flex items-center gap-px'
      role='group'
    >
      <Button
        aria-label={t('Zoom out')}
        disabled={props.disabled}
        onClick={props.onZoomOut}
        size='icon-sm'
        title={t('Zoom out')}
        type='button'
        variant='ghost'
      >
        <Minus aria-hidden='true' />
      </Button>
      <Button
        aria-label={t('Reset zoom to 100%')}
        className='min-w-12 font-mono text-xs'
        disabled={props.disabled}
        onClick={props.onResetZoom}
        title={t('Reset zoom to 100%')}
        type='button'
        variant='ghost'
      >
        {Math.round(props.zoom * 100)}%
      </Button>
      <Button
        aria-label={t('Zoom in')}
        disabled={props.disabled}
        onClick={props.onZoomIn}
        size='icon-sm'
        title={t('Zoom in')}
        type='button'
        variant='ghost'
      >
        <Plus aria-hidden='true' />
      </Button>
      <Button
        aria-label={t('Fit view')}
        disabled={props.disabled}
        onClick={props.onFitView}
        size='icon-sm'
        title={t('Fit view')}
        type='button'
        variant='ghost'
      >
        <Maximize aria-hidden='true' />
      </Button>
    </div>
  )
}

/** The same controls wired to the surrounding xyflow viewport. */
export function CanvasViewportControls(props: { disabled?: boolean }) {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow()
  const { zoom } = useViewport()
  return (
    <CanvasViewportControlsView
      disabled={props.disabled}
      onFitView={() => void fitView({ duration: 200, padding: 0.2 })}
      onResetZoom={() => void zoomTo(1, { duration: 200 })}
      onZoomIn={() => void zoomIn({ duration: 150 })}
      onZoomOut={() => void zoomOut({ duration: 150 })}
      zoom={zoom}
    />
  )
}
