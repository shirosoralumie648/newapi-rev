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
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pin,
  PinOff,
  Tags,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import type {
  PlaygroundSession,
  PlaygroundSessionOrganization,
} from '../../types'

interface PlaygroundSessionOrganizationMenuProps {
  disabled?: boolean
  session: PlaygroundSession
  onOrganize: (organization: PlaygroundSessionOrganization) => void
  onManageTags: () => void
}

/**
 * Pin, archive and tag actions of one conversation. Pinning is hidden while
 * archived because the server rejects that contradictory state.
 */
export function PlaygroundSessionOrganizationMenu(
  props: PlaygroundSessionOrganizationMenuProps
) {
  const { t } = useTranslation()
  const displayTitle =
    props.session.title === 'New conversation'
      ? t('New conversation')
      : props.session.title

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t('Organize {{name}}', { name: displayTitle })}
            className='text-muted-foreground hover:text-foreground opacity-70 group-hover:opacity-100 focus-visible:opacity-100'
            disabled={props.disabled}
            size='icon-xs'
            type='button'
            variant='ghost'
          />
        }
      >
        <MoreHorizontal aria-hidden='true' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-48'>
        {!props.session.archived && (
          <DropdownMenuItem
            onClick={() => props.onOrganize({ pinned: !props.session.pinned })}
          >
            {props.session.pinned ? (
              <PinOff aria-hidden='true' />
            ) : (
              <Pin aria-hidden='true' />
            )}
            {t(
              props.session.pinned ? 'Unpin conversation' : 'Pin conversation'
            )}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() =>
            props.onOrganize({ archived: !props.session.archived })
          }
        >
          {props.session.archived ? (
            <ArchiveRestore aria-hidden='true' />
          ) : (
            <Archive aria-hidden='true' />
          )}
          {t(
            props.session.archived
              ? 'Restore conversation'
              : 'Archive conversation'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={props.onManageTags}>
          <Tags aria-hidden='true' />
          {t('Manage tags')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
