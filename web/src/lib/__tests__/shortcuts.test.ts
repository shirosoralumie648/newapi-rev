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
import { expect, test } from 'vitest'

import {
  formatShortcutHint,
  formatShortcutKeys,
  isEditableShortcutTarget,
  isMacPlatform,
  isShortcutOverlayTarget,
  isShortcutsHelpShortcut,
  isShortcutSuppressedTarget,
  matchShortcut,
  matchesShortcutBinding,
  type ShortcutDefinition,
} from '../shortcuts'

const redo: ShortcutDefinition = {
  id: 'redo',
  group: 'workspace',
  label: 'Redo',
  bindings: [
    { key: 'z', mod: true, shift: true, alt: false },
    { key: 'y', mod: true, shift: false, alt: false },
  ],
}

test('mod chords accept the platform primary modifier and reject extra shift', () => {
  const undo = { key: 'z', mod: true, shift: false, alt: false }
  const base = {
    key: 'z',
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
  }

  expect(matchesShortcutBinding(base, undo)).toBe(true)
  expect(matchesShortcutBinding({ ...base, metaKey: true }, undo)).toBe(true)
  expect(matchesShortcutBinding({ ...base, altKey: true }, undo)).toBe(false)
  expect(matchesShortcutBinding({ ...base, shiftKey: true }, undo)).toBe(false)
})

test('a shortcut matches any of its defined chords', () => {
  const base = { metaKey: false, altKey: false }
  expect(
    matchShortcut({ ...base, key: 'z', ctrlKey: true, shiftKey: true }, redo)
  ).toBe(true)
  expect(
    matchShortcut({ ...base, key: 'y', ctrlKey: true, shiftKey: false }, redo)
  ).toBe(true)
  expect(
    matchShortcut({ ...base, key: 'z', ctrlKey: true, shiftKey: false }, redo)
  ).toBe(false)
})

test('the help question mark ignores modifiers but edits keep their own keys', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false }
  expect(isShortcutsHelpShortcut({ ...base, key: '?', shiftKey: true })).toBe(
    true
  )
  expect(isShortcutsHelpShortcut({ ...base, key: '?', shiftKey: false })).toBe(
    true
  )
  expect(
    isShortcutsHelpShortcut({
      ...base,
      key: '?',
      shiftKey: true,
      ctrlKey: true,
    })
  ).toBe(false)

  const input = document.createElement('input')
  expect(isEditableShortcutTarget(input)).toBe(true)
  expect(isShortcutOverlayTarget(input)).toBe(false)
  expect(isShortcutSuppressedTarget(input)).toBe(true)
  expect(isShortcutSuppressedTarget(document.createElement('div'))).toBe(false)

  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const button = document.createElement('button')
  dialog.append(button)
  expect(isEditableShortcutTarget(button)).toBe(false)
  expect(isShortcutOverlayTarget(button)).toBe(true)
  expect(isShortcutSuppressedTarget(button)).toBe(true)
})

test('shortcut chips follow the platform and keep nudge arrows together', () => {
  const primary = formatShortcutKeys({ key: 'z', mod: true })[0]
  expect(primary).toBe(isMacPlatform() ? '⌘' : 'Ctrl')
  expect(formatShortcutHint({ key: 'z', mod: true })).toBe(
    `${isMacPlatform() ? '⌘' : 'Ctrl'}+Z`
  )
  expect(
    formatShortcutKeys({
      key: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
      shift: true,
    })
  ).toEqual([isMacPlatform() ? '⇧' : 'Shift', '← / → / ↑ / ↓'])
})
