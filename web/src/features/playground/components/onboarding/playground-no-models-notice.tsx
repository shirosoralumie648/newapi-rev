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
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

/**
 * Shared guidance for an account whose current group has no chat model. It is
 * shown by the welcome card and the empty conversation state, and only points
 * at the administrator or another group: the Playground never changes a
 * membership or model catalog on its own.
 */
export function PlaygroundNoModelsNotice({
  className,
}: {
  className?: string
}) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        'border-amber-500/30 bg-amber-500/10 flex gap-3 rounded-xl border p-3 text-left',
        className
      )}
      role='status'
    >
      <TriangleAlert
        aria-hidden='true'
        className='mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400'
      />
      <div className='grid gap-1'>
        <p className='text-sm font-medium'>
          {t('No models are available for this group.')}
        </p>
        <p className='text-muted-foreground text-xs leading-5'>
          {t(
            'Ask an administrator to grant access to this group, or switch to another group.'
          )}
        </p>
      </div>
    </div>
  )
}
