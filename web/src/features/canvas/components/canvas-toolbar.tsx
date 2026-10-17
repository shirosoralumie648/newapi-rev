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
import { Download, Plus, Redo2, Undo2, Upload } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import {
  CANVAS_NODE_KINDS,
  CANVAS_NODE_KIND_LABELS,
} from '../constants'
import type { CanvasNodeKind } from '../types'

interface CanvasToolbarProps {
  disabled?: boolean
  canUndo: boolean
  canRedo: boolean
  onAddNode: (kind: CanvasNodeKind) => void
  onUndo: () => void
  onRedo: () => void
  onImportFile: (file: File) => void
  onExport: () => void
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className='flex flex-wrap items-center gap-1'>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={<Button size='sm' type='button' variant='outline' />}
        >
          <Plus aria-hidden='true' />
          {t('Add node')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-40'>
          {CANVAS_NODE_KINDS.map((kind) => (
            <DropdownMenuItem
              key={kind}
              onClick={() => props.onAddNode(kind)}
            >
              {t(CANVAS_NODE_KIND_LABELS[kind])}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        aria-label={t('Undo')}
        disabled={props.disabled || !props.canUndo}
        onClick={props.onUndo}
        size='icon-sm'
        type='button'
        variant='outline'
      >
        <Undo2 aria-hidden='true' />
      </Button>
      <Button
        aria-label={t('Redo')}
        disabled={props.disabled || !props.canRedo}
        onClick={props.onRedo}
        size='icon-sm'
        type='button'
        variant='outline'
      >
        <Redo2 aria-hidden='true' />
      </Button>

      <input
        accept='application/json,.json'
        className='hidden'
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) props.onImportFile(file)
          event.target.value = ''
        }}
        ref={inputRef}
        type='file'
      />
      <Button
        disabled={props.disabled}
        onClick={() => inputRef.current?.click()}
        size='sm'
        type='button'
        variant='outline'
      >
        <Upload aria-hidden='true' />
        {t('Import')}
      </Button>
      <Button
        disabled={props.disabled}
        onClick={props.onExport}
        size='sm'
        type='button'
        variant='outline'
      >
        <Download aria-hidden='true' />
        {t('Export')}
      </Button>
    </div>
  )
}
