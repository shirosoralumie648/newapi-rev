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
import { useReactFlow } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

import { CANVAS_NODE_KINDS, CANVAS_NODE_KIND_LABELS } from '../constants'
import {
  canvasNodeSearchPreview,
  canvasSearchNodes,
  type CanvasNodeSearchKind,
} from '../lib/canvas-organization'
import type { CanvasFlowNode } from '../types'
import { CanvasNodeColorDot } from './canvas-node'

export interface CanvasNodeSearchViewProps {
  open: boolean
  nodes: CanvasFlowNode[]
  onOpenChange: (open: boolean) => void
  /** Selects the chosen node; the wrapper also centers the viewport on it. */
  onSelectNode: (nodeId: string) => void
}

/**
 * The in-canvas node search panel. cmdk is used with its own filtering turned
 * off: `canvasSearchNodes` owns the name/tag/content matching and the kind
 * filter, so the panel and the tested search behavior cannot drift apart.
 */
export function CanvasNodeSearchView(props: CanvasNodeSearchViewProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<CanvasNodeSearchKind>('all')
  const open = props.open
  const nodes = props.nodes

  useEffect(() => {
    if (!open) return
    setQuery('')
    setKind('all')
  }, [open])

  const matches = useMemo(
    () =>
      canvasSearchNodes(nodes, query, kind, {
        kindLabel: (nodeKind) => t(CANVAS_NODE_KIND_LABELS[nodeKind]),
      }),
    [kind, nodes, query, t]
  )

  return (
    <CommandDialog
      description={t('Search this canvas by node name, content or tag.')}
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={t('Search nodes')}
    >
      <Command shouldFilter={false}>
        <div className='flex items-center gap-2 pr-2'>
          <div className='min-w-0 flex-1'>
            <CommandInput
              autoFocus
              onValueChange={setQuery}
              placeholder={t('Search nodes...')}
              value={query}
            />
          </div>
          <NativeSelect
            aria-label={t('Node type')}
            className='w-32 shrink-0'
            onChange={(event) =>
              setKind(event.target.value as CanvasNodeSearchKind)
            }
            size='sm'
            value={kind}
          >
            <NativeSelectOption value='all'>
              {t('All types')}
            </NativeSelectOption>
            {CANVAS_NODE_KINDS.map((nodeKind) => (
              <NativeSelectOption key={nodeKind} value={nodeKind}>
                {t(CANVAS_NODE_KIND_LABELS[nodeKind])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <CommandList>
          <CommandEmpty>{t('No matching nodes.')}</CommandEmpty>
          {matches.map((node) => {
            const preview = canvasNodeSearchPreview(node.data)
            const kindLabel = t(CANVAS_NODE_KIND_LABELS[node.data.kind])
            const label = node.data.label?.trim() || kindLabel
            return (
              <CommandItem
                key={node.id}
                onSelect={() => props.onSelectNode(node.id)}
                value={node.id}
              >
                <CanvasNodeColorDot color={node.data.color} />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='truncate'>{label}</span>
                    <span className='text-muted-foreground ml-auto shrink-0 text-xs'>
                      {kindLabel}
                    </span>
                  </div>
                  {preview ? (
                    <p className='text-muted-foreground truncate text-xs'>
                      {preview}
                    </p>
                  ) : null}
                  {node.data.tags && node.data.tags.length > 0 ? (
                    <p className='text-muted-foreground truncate text-xs'>
                      {node.data.tags.join(' · ')}
                    </p>
                  ) : null}
                </div>
              </CommandItem>
            )
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/**
 * The provider-bound wrapper: it runs the selection callback and pans the
 * viewport to the chosen node, so opening a result is a keyboard-only action.
 */
export function CanvasNodeSearch(props: CanvasNodeSearchViewProps) {
  const { fitView } = useReactFlow()
  const onOpenChange = props.onOpenChange
  const onSelectNode = props.onSelectNode

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      onSelectNode(nodeId)
      onOpenChange(false)
      void fitView({
        duration: 300,
        maxZoom: 1.25,
        nodes: [{ id: nodeId }],
        padding: 2,
      })
    },
    [fitView, onOpenChange, onSelectNode]
  )

  return <CanvasNodeSearchView {...props} onSelectNode={handleSelectNode} />
}
