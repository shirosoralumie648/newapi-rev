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
import type { ShortcutDefinition } from '@/lib/shortcuts'

export const PLAYGROUND_COMMAND_PALETTE_BINDING = {
  key: 'k',
  mod: true,
  shift: false,
  alt: false,
} as const

export const PLAYGROUND_MESSAGE_JUMP_BINDING = {
  key: 'j',
  mod: true,
  shift: false,
  alt: false,
} as const

export const PLAYGROUND_MESSAGE_SEARCH_BINDING = {
  key: 'f',
  mod: true,
  shift: true,
  alt: false,
} as const

/**
 * Chat-workspace chords. The command palette, message jump and cross-session
 * search are wired in `features/playground/index.tsx`; the composer rows
 * document behavior `PlaygroundInput` implements locally.
 */
export const PLAYGROUND_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'playground-command-palette',
    group: 'workspace',
    label: 'Open command palette',
    bindings: [PLAYGROUND_COMMAND_PALETTE_BINDING],
  },
  {
    id: 'playground-message-jump',
    group: 'workspace',
    label: 'Jump to message',
    bindings: [PLAYGROUND_MESSAGE_JUMP_BINDING],
  },
  {
    id: 'playground-message-search',
    group: 'workspace',
    label: 'Search messages',
    bindings: [PLAYGROUND_MESSAGE_SEARCH_BINDING],
  },
  {
    id: 'playground-shortcuts-help',
    group: 'workspace',
    label: 'Keyboard shortcuts',
    bindings: [{ key: '?', shift: true, alt: false }],
  },
  {
    id: 'playground-send',
    group: 'composer',
    label: 'Send message',
    bindings: [{ key: 'Enter', shift: false, alt: false }],
  },
  {
    id: 'playground-newline',
    group: 'composer',
    label: 'Insert newline',
    bindings: [{ key: 'Enter', shift: true, alt: false }],
  },
]
