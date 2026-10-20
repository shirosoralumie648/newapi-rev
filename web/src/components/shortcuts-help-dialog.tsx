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
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  formatShortcutKeys,
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_GROUP_ORDER,
  type ShortcutDefinition,
} from '@/lib/shortcuts'

interface ShortcutsHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Registry the workspace actually binds, so the overlay cannot drift. */
  shortcuts: readonly ShortcutDefinition[]
  title?: string
  description?: string
}

/**
 * Read-only keyboard reference shared by the chat workspace and the canvas.
 * Each caller passes its live registry; entries render in a fixed group order
 * and every chord comes from `formatShortcutKeys`, which follows the platform.
 */
export function ShortcutsHelpDialog(props: ShortcutsHelpDialogProps) {
  const { t } = useTranslation()
  const sections = SHORTCUT_GROUP_ORDER.map((group) => ({
    group,
    shortcuts: props.shortcuts.filter((shortcut) => shortcut.group === group),
  })).filter((section) => section.shortcuts.length > 0)

  return (
    <Dialog
      description={
        props.description ?? t('Shortcuts available in this workspace.')
      }
      onOpenChange={(open) => props.onOpenChange(open)}
      open={props.open}
      title={props.title ?? t('Keyboard shortcuts')}
    >
      <div className='grid gap-5'>
        {sections.map((section) => (
          <section
            aria-labelledby={`shortcuts-group-${section.group}`}
            key={section.group}
          >
            <h3
              className='text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase'
              id={`shortcuts-group-${section.group}`}
            >
              {t(SHORTCUT_GROUP_LABELS[section.group])}
            </h3>
            <ul className='grid gap-1'>
              {section.shortcuts.map((shortcut) => (
                <li
                  className='flex min-h-8 items-center justify-between gap-4 rounded-sm px-2 py-1 text-sm'
                  key={shortcut.id}
                >
                  <span>{t(shortcut.label)}</span>
                  <span className='flex shrink-0 flex-wrap items-center justify-end gap-2'>
                    {shortcut.bindings.map((binding, index) => (
                      <span
                        className='flex items-center gap-2'
                        key={`${shortcut.id}-${index}`}
                      >
                        {index > 0 ? (
                          <span className='text-muted-foreground text-xs'>
                            /
                          </span>
                        ) : null}
                        <KbdGroup>
                          {formatShortcutKeys(binding).map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </KbdGroup>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
