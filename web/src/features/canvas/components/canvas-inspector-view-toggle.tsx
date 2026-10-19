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
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { CanvasInspectorView } from '../types'

interface CanvasInspectorViewToggleProps {
  view: CanvasInspectorView
  onViewChange: (view: CanvasInspectorView) => void
  className?: string
}

/**
 * The in-sheet switch between the node details and the assistant. On desktop
 * the toolbar button toggles the assistant, but the mobile inspector lives in
 * a modal Sheet that covers the toolbar, so the sheet carries its own switch.
 */
export function CanvasInspectorViewToggle(
  props: CanvasInspectorViewToggleProps
) {
  const { t } = useTranslation()
  const views: Array<{ value: CanvasInspectorView; label: string }> = [
    { value: 'details', label: t('Node details') },
    { value: 'assistant', label: t('Assistant') },
    { value: 'generate', label: t('Generate') },
    { value: 'library', label: t('Library') },
    { value: 'artifacts', label: t('Artifacts') },
  ]

  return (
    <div
      aria-label={t('View mode')}
      className={cn(
        'bg-muted/60 flex flex-wrap items-center gap-0.5 rounded-lg border p-0.5',
        props.className
      )}
      role='group'
    >
      {views.map((entry) => (
        <Button
          aria-pressed={entry.value === props.view}
          key={entry.value}
          onClick={() => props.onViewChange(entry.value)}
          size='sm'
          type='button'
          variant={entry.value === props.view ? 'secondary' : 'ghost'}
        >
          {entry.label}
        </Button>
      ))}
    </div>
  )
}
