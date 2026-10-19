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
  Bot,
  Download,
  FileText,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  Redo2,
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { GroupOption } from '@/features/playground/types'

import { CANVAS_NODE_KINDS, CANVAS_NODE_KIND_LABELS } from '../constants'
import type { CanvasWorkflowRunPhase } from '../hooks/use-canvas-workflow-runner'
import type { CanvasInspectorView, CanvasNodeKind } from '../types'

/** Inspector views the toolbar can open; the creator owns the whole domain. */
export type CanvasToolbarInspectorView =
  | 'assistant'
  | 'generate'
  | 'library'
  | 'artifacts'

interface CanvasToolbarProps {
  disabled?: boolean
  canUndo: boolean
  canRedo: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
  canGroup: boolean
  canUngroup: boolean
  /** Whether exporting the selected nodes is possible. */
  canExportSelection: boolean
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
  onImportFile: (file: File) => void
  onImportArchiveFile: (file: File) => void
  onExport: () => void
  onExportArchive: () => void
  onExportSelectionArchive: () => void
  onToggleInspectorView: (view: CanvasToolbarInspectorView) => void
  onRunWorkflow: () => void
  onCancelRun: () => void
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
        </DropdownMenuContent>
      </DropdownMenu>

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
        <Button
          disabled={props.disabled}
          onClick={props.onRunWorkflow}
          size='sm'
          type='button'
        >
          <Play aria-hidden='true' />
          {t('Run workflow')}
        </Button>
      )}
    </div>
  )
}
