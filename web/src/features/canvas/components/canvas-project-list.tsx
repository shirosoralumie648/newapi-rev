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
import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

import type { CanvasProjectMode, CanvasProjectSummary } from '../types'
import { CanvasProjectItem } from './canvas-project-item'

interface CanvasProjectListProps {
  disabled?: boolean
  projects: CanvasProjectSummary[]
  activeProjectId: string | null
  onCreate: (mode?: CanvasProjectMode) => void
  onSelect: (projectId: string) => void
  onRename: (projectId: string, title: string) => void
  onDelete: (projectId: string) => void
  onAction?: () => void
}

export function CanvasProjectList(props: CanvasProjectListProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [projectToDelete, setProjectToDelete] =
    useState<CanvasProjectSummary | null>(null)

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return [...props.projects]
      .sort((first, second) => second.updatedAt - first.updatedAt)
      .filter((project) =>
        normalizedQuery
          ? project.title.toLowerCase().includes(normalizedQuery)
          : true
      )
  }, [props.projects, query])

  const handleDelete = () => {
    if (!projectToDelete) return
    props.onDelete(projectToDelete.id)
    setProjectToDelete(null)
    props.onAction?.()
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='flex items-center gap-2'>
        <div className='relative min-w-0 flex-1'>
          <Search
            aria-hidden='true'
            className='text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2'
          />
          <Input
            aria-label={t('Search canvases')}
            className='h-8 pl-8'
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('Search canvases')}
            value={query}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t('New canvas')}
                disabled={props.disabled}
                size='icon'
                type='button'
              />
            }
          >
            <Plus aria-hidden='true' />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuItem
              onClick={() => {
                props.onCreate('infinite')
                props.onAction?.()
              }}
            >
              {t('Infinite canvas')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                props.onCreate('image')
                props.onAction?.()
              }}
            >
              {t('Image workbench')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea className='min-h-0 flex-1'>
        <div className='grid gap-1 pr-2'>
          {visibleProjects.map((project) => (
            <CanvasProjectItem
              disabled={props.disabled}
              isActive={project.id === props.activeProjectId}
              key={project.id}
              onDelete={() => setProjectToDelete(project)}
              onRename={(title) => props.onRename(project.id, title)}
              onSelect={() => {
                props.onSelect(project.id)
                props.onAction?.()
              }}
              project={project}
            />
          ))}
          {visibleProjects.length === 0 && (
            <p className='text-muted-foreground px-2 py-6 text-center text-sm'>
              {t('No canvases found')}
            </p>
          )}
        </div>
      </ScrollArea>

      <ConfirmDialog
        confirmText={t('Move to trash')}
        desc={t(
          'The canvas and its nodes move to the trash and can be restored until the retention period ends.'
        )}
        destructive
        handleConfirm={handleDelete}
        onOpenChange={(open) => {
          if (!open) setProjectToDelete(null)
        }}
        open={projectToDelete !== null}
        title={t('Move canvas to trash?')}
      />
    </div>
  )
}
