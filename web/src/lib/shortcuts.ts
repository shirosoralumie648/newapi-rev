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

/**
 * One keyboard chord. A definition may carry several chords (`Cmd+Z` and
 * `Ctrl+Z`, or the two delete keys) and every one of them means the same
 * action. Modifier flags that are left undefined are ignored, so `?` can keep
 * its layout-dependent Shift while ordinary letter chords reject it.
 */
export interface ShortcutBinding {
  /** `event.key` values, matched case-insensitively. */
  key: string | readonly string[]
  /** Cmd on macOS and Ctrl elsewhere; both are accepted for portability. */
  mod?: boolean
  /** Ctrl on every platform. */
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export type ShortcutGroup =
  | 'workspace'
  | 'canvas-editing'
  | 'canvas-navigation'
  | 'composer'

export interface ShortcutDefinition {
  id: string
  group: ShortcutGroup
  /** i18n key of the action name. */
  label: string
  bindings: readonly ShortcutBinding[]
}

export interface ShortcutKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = [
  'workspace',
  'canvas-editing',
  'canvas-navigation',
  'composer',
]

export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  workspace: 'Workspace',
  'canvas-editing': 'Canvas editing',
  'canvas-navigation': 'Canvas navigation',
  composer: 'Composer',
}

const SHORTCUT_KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  escape: 'Esc',
  enter: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'Page up',
  pagedown: 'Page down',
  tab: 'Tab',
}

/** Whether the current client runs on an Apple platform. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
}

function matchesKey(event: ShortcutKeyEvent, key: ShortcutBinding['key']) {
  const pressed = event.key.toLocaleLowerCase()
  const keys = typeof key === 'string' ? [key] : key
  return keys.some((candidate) => candidate.toLocaleLowerCase() === pressed)
}

function matchesModifier(
  required: boolean | undefined,
  pressed: boolean
): boolean {
  return required === undefined ? true : required === pressed
}

/**
 * Matches one chord exactly. Undefined modifier flags mean "don't care";
 * `mod` is satisfied by either Cmd or Ctrl so a saved shortcut keeps working
 * when the same browser profile moves between platforms.
 */
export function matchesShortcutBinding(
  event: ShortcutKeyEvent,
  binding: ShortcutBinding
): boolean {
  if (!matchesKey(event, binding.key)) return false
  if (binding.mod) {
    if (!event.metaKey && !event.ctrlKey) return false
  } else if (!binding.ctrl && (event.metaKey || event.ctrlKey)) {
    return false
  }
  if (binding.ctrl && !event.ctrlKey) return false
  if (!matchesModifier(binding.shift, event.shiftKey)) return false
  if (!matchesModifier(binding.alt, event.altKey)) return false
  return true
}

/** Matches any chord of one shortcut definition. */
export function matchShortcut(
  event: ShortcutKeyEvent,
  definition: ShortcutDefinition
): boolean {
  return definition.bindings.some((binding) =>
    matchesShortcutBinding(event, binding)
  )
}

/** `?` opens the shortcut help overlay outside editable fields. */
export function isShortcutsHelpShortcut(event: ShortcutKeyEvent): boolean {
  return event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey
}

/**
 * Fields where plain characters (including `?`) belong to the field. Modifier
 * chords may still be handled by a workspace unless it deliberately keeps the
 * native behavior, as the canvas editor does for undo and copy.
 */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/** Open menus, dialogs and listboxes own every key while they are focused. */
export function isShortcutOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.closest(
      '[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [role="slider"]'
    ) !== null
  )
}

/**
 * Fields and open overlays keep their own key handling. Canvas editing already
 * relied on this rule; the shared registry makes the help overlay obey it too.
 */
export function isShortcutSuppressedTarget(
  target: EventTarget | null
): boolean {
  return isEditableShortcutTarget(target) || isShortcutOverlayTarget(target)
}

function formatKeyLabel(key: string): string {
  const normalized = key.toLocaleLowerCase()
  return SHORTCUT_KEY_LABELS[normalized] ?? key.toLocaleUpperCase()
}

/**
 * Renders a chord as the Kbd sequence of the current platform. Arrow sets such
 * as the four nudge keys stay in one string because they form one row.
 */
export function formatShortcutKeys(binding: ShortcutBinding): string[] {
  const mac = isMacPlatform()
  const keys: string[] = []
  if (binding.mod) keys.push(mac ? '⌘' : 'Ctrl')
  if (binding.ctrl) keys.push(mac ? '⌃' : 'Ctrl')
  if (binding.shift) keys.push(mac ? '⇧' : 'Shift')
  if (binding.alt) keys.push(mac ? '⌥' : 'Alt')
  const key =
    typeof binding.key === 'string'
      ? formatKeyLabel(binding.key)
      : binding.key.map(formatKeyLabel).join(' / ')
  keys.push(key)
  return keys
}

/** One-line shortcut hint for command rows. */
export function formatShortcutHint(binding: ShortcutBinding): string {
  return formatShortcutKeys(binding).join('+')
}
