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
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  History,
  LayoutGrid,
  LayoutTemplate,
  ListChecks,
  Pencil,
  Play,
  Plus,
  Redo2,
  Search,
  Sparkles,
  Square,
  Undo2,
  Upload,
} from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { GroupOption } from '@/features/playground/types'

import { CANVAS_NODE_KINDS, CANVAS_NODE_KIND_LABELS } from '../constants'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import type {
  CanvasAlignAxis,
  CanvasAutoLayoutDirection,
} from '../lib/canvas-align'
import type { CanvasInspectorView, CanvasNodeKind } from '../types'

/** Inspector views the toolbar can open; the creator owns the whole domain. */
export type CanvasToolbarInspectorView =
  | 'assistant'
  | 'generate'
  | 'library'
  | 'artifacts'
  | 'history'

interface CanvasToolbarProps {
  disabled?: boolean
  canUndo: boolean
  canRedo: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
  canGroup: boolean
  canUngroup: boolean
  canDistribute: boolean
  canAlign: boolean
  canAutoLayout: boolean
  canCollapse: boolean
  canExpand: boolean
  /** Whether exporting the selected nodes is possible. */
  canExportSelection: boolean
  /** Whether the selected subgraph can be run now. */
  canRunSelection: boolean
  exportingPng: boolean
  runPhase: CanvasWorkflowRunPhase
  /** Which inspector view is open; `details` means none of the switches. */
  inspectorView: CanvasInspectorView
  group: string
  groups: GroupOption[]
  onGroupChange: (group: string) => void
  onAddNode: (kind: CanvasNodeKind) => void
  onUndo: () => void
  onRedo: () => void
  onCopy: () => void
  onPaste: () => void
  onSelectAll: () => void
  onGroupSelection: () => void
  onUngroupSelection: () => void
  onAlign: (alignment: CanvasAlignAxis) => void
  onAutoLayout: (direction: CanvasAutoLayoutDirection) => void
  onCollapseSelection: () => void
  onExpandSelection: () => void
  onDistributeHorizontal: () => void
  onDistributeVertical: () => void
  onImportFile: (file: File) => void
  onImportArchiveFile: (file: File) => void
  onExport: () => void
  onExportPng: () => void
  onExportSelectionPng: () => void
  onExportArchive: () => void
  onExportSelectionArchive: () => void
  onOpenTemplates: () => void
  onToggleInspectorView: (view: CanvasToolbarInspectorView) => void
  onRunWorkflow: () => void
  onRunSelection: () => void
  onCancelRun: () => void
  onSearchNodes: () => void
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)
  const running = props.runPhase === 'running'
  const inspectorSwitches: Array<{
    view: CanvasToolbarInspectorView
    label: string
    icon: typeof Bot
  }> = [
    { view: 'generate', label: t('Generate'), icon: Sparkles },
    { view: 'library', label: t('Library'), icon: FolderOpen },
    { view: 'artifacts', label: t('Artifacts'), icon: FileText },
    { view: 'history', label: t('Run history'), icon: History },
    { view: 'assistant', label: t('Assistant'), icon: Bot },
  ]

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
            <DropdownMenuItem key={kind} onClick={() => props.onAddNode(kind)}>
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

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={<Button size='sm' type='button' variant='outline' />}
        >
          <Pencil aria-hidden='true' />
          {t('Edit')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-44'>
          <DropdownMenuItem
            disabled={props.disabled || !props.canCopy}
            onClick={props.onCopy}
          >
            {t('Copy')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canPaste}
            onClick={props.onPaste}
          >
            {t('Paste')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canSelectAll}
            onClick={props.onSelectAll}
          >
            {t('Select all')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canGroup}
            onClick={props.onGroupSelection}
          >
            {t('Group selection')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canUngroup}
            onClick={props.onUngroupSelection}
          >
            {t('Ungroup selection')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={props.disabled || !props.canAlign}
            onClick={() => props.onAlign('left')}
          >
            <AlignStartVertical aria-hidden='true' />
            {t('Align left')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canAlign}
            onClick={() => props.onAlign('center')}
          >
            <AlignCenterVertical aria-hidden='true' />
            {t('Align center')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canAlign}
            onClick={() => props.onAlign('right')}
          >
            <AlignEndVertical aria-hidden='true' />
            {t('Align right')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canAlign}
            onClick={() => props.onAlign('top')}
          >
            <AlignStartHorizontal aria-hidden='true' />
            {t('Align top')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canAlign}
            onClick={() => props.onAlign('middle')}
          >
            <AlignCenterHorizontal aria-hidden='true' />
            {t('Align middle')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canAlign}
            onClick={() => props.onAlign('bottom')}
          >
            <AlignEndHorizontal aria-hidden='true' />
            {t('Align bottom')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canDistribute}
            onClick={props.onDistributeHorizontal}
          >
            <AlignHorizontalSpaceAround aria-hidden='true' />
            {t('Distribute horizontally')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canDistribute}
            onClick={props.onDistributeVertical}
          >
            <AlignVerticalSpaceAround aria-hidden='true' />
            {t('Distribute vertically')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={props.disabled || !props.canAutoLayout}
            onClick={() => props.onAutoLayout('horizontal')}
          >
            <LayoutGrid aria-hidden='true' />
            {t('Auto layout horizontally')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canAutoLayout}
            onClick={() => props.onAutoLayout('vertical')}
          >
            <LayoutGrid aria-hidden='true' />
            {t('Auto layout vertically')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={props.disabled || !props.canCollapse}
            onClick={props.onCollapseSelection}
          >
            <ChevronDown aria-hidden='true' />
            {t('Collapse selection')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || !props.canExpand}
            onClick={props.onExpandSelection}
          >
            <ChevronRight aria-hidden='true' />
            {t('Expand selection')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        disabled={props.disabled}
        onClick={props.onOpenTemplates}
        size='sm'
        type='button'
        variant='outline'
      >
        <LayoutTemplate aria-hidden='true' />
        {t('Templates')}
      </Button>

      {inspectorSwitches.map((entry) => {
        const Icon = entry.icon
        const active = props.inspectorView === entry.view
        return (
          <Button
            aria-pressed={active}
            disabled={props.disabled}
            key={entry.view}
            onClick={() => props.onToggleInspectorView(entry.view)}
            size='sm'
            type='button'
            variant={active ? 'secondary' : 'outline'}
          >
            <Icon aria-hidden='true' />
            {entry.label}
          </Button>
        )
      })}

      <input
        accept='application/json,.json'
        aria-label={t('Import canvas JSON file')}
        className='hidden'
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) props.onImportFile(file)
          event.target.value = ''
        }}
        ref={inputRef}
        type='file'
      />
      <input
        accept='.zip,application/zip'
        aria-label={t('Import canvas archive file')}
        className='hidden'
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) props.onImportArchiveFile(file)
          event.target.value = ''
        }}
        ref={archiveInputRef}
        type='file'
      />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              disabled={props.disabled}
              size='sm'
              type='button'
              variant='outline'
            />
          }
        >
          <Upload aria-hidden='true' />
          {t('Import')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-44'>
          <DropdownMenuItem onClick={() => inputRef.current?.click()}>
            {t('JSON file')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => archiveInputRef.current?.click()}>
            {t('ZIP archive')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              disabled={props.disabled}
              size='sm'
              type='button'
              variant='outline'
            />
          }
        >
          <Download aria-hidden='true' />
          {t('Export')}
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-44'>
          <DropdownMenuItem
            disabled={props.exportingPng}
            onClick={props.onExportPng}
          >
            {t('PNG image')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.exportingPng || !props.canExportSelection}
            onClick={props.onExportSelectionPng}
          >
            {t('PNG of selected nodes')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={props.onExport}>
            {t('JSON file')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={props.onExportArchive}>
            {t('ZIP archive')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!props.canExportSelection}
            onClick={props.onExportSelectionArchive}
          >
            {t('ZIP archive of selected nodes')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {props.groups.length > 0 ? (
        <NativeSelect
          aria-label={t('Group')}
          className='w-32'
          disabled={props.disabled || running}
          onChange={(event) => props.onGroupChange(event.target.value)}
          size='sm'
          value={props.group}
        >
          {props.groups.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}

      {running ? (
        <Button
          onClick={props.onCancelRun}
          size='sm'
          type='button'
          variant='destructive'
        >
          <Square aria-hidden='true' />
          {t('Cancel run')}
        </Button>
      ) : (
        <>
          <Button
            disabled={props.disabled || !props.canRunSelection}
            onClick={props.onRunSelection}
            size='sm'
            type='button'
            variant='outline'
          >
            <ListChecks aria-hidden='true' />
            {t('Run selected')}
          </Button>
          <Button
            disabled={props.disabled}
            onClick={props.onRunWorkflow}
            size='sm'
            type='button'
          >
            <Play aria-hidden='true' />
            {t('Run workflow')}
          </Button>
        </>
      )}

      <Button
        aria-label={t('Search nodes')}
        disabled={props.disabled}
        onClick={props.onSearchNodes}
        size='icon-sm'
        type='button'
        variant='outline'
      >
        <Search aria-hidden='true' />
      </Button>
    </div>
  )
}
