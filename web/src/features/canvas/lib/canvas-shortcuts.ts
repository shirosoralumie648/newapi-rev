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
import type { ShortcutBinding, ShortcutDefinition } from '@/lib/shortcuts'

/** Cmd+P on macOS and Ctrl+P elsewhere. */
export const CANVAS_NODE_SEARCH_BINDING: ShortcutBinding = {
  key: 'p',
  mod: true,
  shift: false,
  alt: false,
}

/**
 * Every canvas keyboard action, in help-panel order. The editor handlers match
 * these entries instead of spelling chords out again, so the overlay cannot
 * drift from the actual bindings.
 */
export const CANVAS_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'canvas-undo',
    group: 'canvas-editing',
    label: 'Undo',
    bindings: [{ key: 'z', mod: true, shift: false, alt: false }],
  },
  {
    id: 'canvas-redo',
    group: 'canvas-editing',
    label: 'Redo',
    bindings: [
      { key: 'z', mod: true, shift: true, alt: false },
      { key: 'y', mod: true, alt: false },
    ],
  },
  {
    id: 'canvas-select-all',
    group: 'canvas-editing',
    label: 'Select all',
    bindings: [{ key: 'a', mod: true, alt: false }],
  },
  {
    id: 'canvas-copy',
    group: 'canvas-editing',
    label: 'Copy',
    bindings: [{ key: 'c', mod: true, shift: false, alt: false }],
  },
  {
    id: 'canvas-paste',
    group: 'canvas-editing',
    label: 'Paste',
    bindings: [{ key: 'v', mod: true, shift: false, alt: false }],
  },
  {
    id: 'canvas-group',
    group: 'canvas-editing',
    label: 'Group selection',
    bindings: [{ key: 'g', mod: true, shift: false, alt: false }],
  },
  {
    id: 'canvas-ungroup',
    group: 'canvas-editing',
    label: 'Ungroup selection',
    bindings: [{ key: 'g', mod: true, shift: true, alt: false }],
  },
  {
    id: 'canvas-delete',
    group: 'canvas-editing',
    label: 'Delete selection',
    bindings: [
      { key: 'Delete', alt: false },
      { key: 'Backspace', alt: false },
    ],
  },
  {
    id: 'canvas-nudge',
    group: 'canvas-navigation',
    label: 'Move selection',
    bindings: [
      {
        key: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
        shift: false,
        alt: false,
      },
    ],
  },
  {
    id: 'canvas-nudge-fast',
    group: 'canvas-navigation',
    label: 'Move selection faster',
    bindings: [
      {
        key: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
        shift: true,
        alt: false,
      },
    ],
  },
  {
    id: 'canvas-search-nodes',
    group: 'canvas-navigation',
    label: 'Search nodes',
    bindings: [CANVAS_NODE_SEARCH_BINDING],
  },
]
