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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'

import {
  filterPlaygroundCommands,
  groupPlaygroundCommands,
  type PlaygroundCommand,
} from '../../lib/command/playground-commands'

interface PlaygroundCommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Live registry of the workspace, already carrying its actions. */
  commands: readonly PlaygroundCommand[]
}

/**
 * One entry point for the workspace: the registry is filtered and ranked by
 * `filterPlaygroundCommands` and rendered without cmdk's own fuzzy filter, so
 * ranking stays deterministic and search-only rows can be hidden until the
 * reader types. cmdk still owns arrow-key navigation, Enter and accessibility.
 */
export function PlaygroundCommandPalette(props: PlaygroundCommandPaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const sections = useMemo(
    () =>
      groupPlaygroundCommands(
        filterPlaygroundCommands(props.commands, query),
        (key) => t(key)
      ),
    [props.commands, query, t]
  )

  const handleOpenChange = (open: boolean) => {
    if (!open) setQuery('')
    props.onOpenChange(open)
  }

  const runCommand = (command: PlaygroundCommand) => {
    handleOpenChange(false)
    command.run()
  }

  return (
    <CommandDialog
      description={t('Search conversations, models and commands.')}
      onOpenChange={handleOpenChange}
      open={props.open}
      title={t('Command palette')}
    >
      <Command loop shouldFilter={false}>
        <CommandInput
          aria-label={t('Command palette')}
          autoFocus
          onValueChange={setQuery}
          placeholder={t('Type a command or search...')}
          value={query}
        />
        <CommandList>
          <CommandEmpty>{t('No matching commands.')}</CommandEmpty>
          {sections.map((section) => (
            <CommandGroup heading={section.heading} key={section.group}>
              {section.commands.map((command) => (
                <CommandItem
                  key={command.id}
                  onSelect={() => runCommand(command)}
                  value={command.id}
                >
                  <span className='truncate'>{command.title}</span>
                  {command.shortcut ? (
                    <CommandShortcut>{command.shortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
