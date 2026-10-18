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
import { Download } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { handleServerError } from '@/lib/handle-server-error'

import { exportPlaygroundSessionFile } from '../../lib/export'
import type { PlaygroundExportFormat } from '../../types'

interface PlaygroundSessionExportMenuProps {
  /** Canonical server id of the conversation to export. */
  sessionId: string
  /** Conversation title, used for the trigger's accessible name. */
  title: string
  disabled?: boolean
  className?: string
}

/**
 * Export actions of one persisted conversation. The host renders the Markdown
 * or JSON file, so the menu also works for a conversation still in the trash.
 */
export function PlaygroundSessionExportMenu(
  props: PlaygroundSessionExportMenuProps
) {
  const { t } = useTranslation()
  const [isExporting, setIsExporting] = useState(false)

  const runExport = async (format: PlaygroundExportFormat) => {
    setIsExporting(true)
    try {
      await exportPlaygroundSessionFile(props.sessionId, format)
      toast.success(t('Conversation exported'))
    } catch (error) {
      handleServerError(error, t('Unable to export the conversation.'))
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t('Export {{name}}', { name: props.title })}
            className={props.className}
            disabled={props.disabled || isExporting}
            size='icon-xs'
            type='button'
            variant='ghost'
          />
        }
      >
        <Download aria-hidden='true' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-44'>
        <DropdownMenuItem onClick={() => void runExport('markdown')}>
          {t('Export as Markdown')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void runExport('json')}>
          {t('Export as JSON')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
