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
import type { NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'

import {
  Node as CanvasNodeCard,
  NodeContent,
  NodeHeader,
  NodeTitle,
} from '@/components/ai-elements/node'
import { cn } from '@/lib/utils'

import { CANVAS_NODE_KIND_LABELS } from '../constants'
import type { CanvasNodeData, CanvasNodeKind } from '../types'

function readNodePreview(data: CanvasNodeData): string {
  return (
    data.text?.trim() ||
    data.snapshot?.text?.trim() ||
    data.label?.trim() ||
    ''
  )
}

export function CanvasFlowNodeView(props: NodeProps) {
  const { t } = useTranslation()
  const data = props.data as CanvasNodeData
  const kind: CanvasNodeKind = data.kind ?? 'text'
  const preview = readNodePreview(data)

  return (
    <CanvasNodeCard
      className={cn(
        'h-auto w-64 gap-0 p-0',
        props.selected && 'ring-ring ring-2'
      )}
      handles={{ target: true, source: true }}
    >
      <NodeHeader className='p-2'>
        <NodeTitle className='text-xs font-medium'>
          {t(CANVAS_NODE_KIND_LABELS[kind])}
        </NodeTitle>
      </NodeHeader>
      <NodeContent className='p-2'>
        {preview ? (
          <p className='text-muted-foreground line-clamp-4 text-xs break-words whitespace-pre-wrap'>
            {preview}
          </p>
        ) : (
          <p className='text-muted-foreground text-xs italic'>
            {t('Empty node')}
          </p>
        )}
      </NodeContent>
    </CanvasNodeCard>
  )
}
