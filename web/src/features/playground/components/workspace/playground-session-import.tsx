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
import { Loader2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

interface PlaygroundSessionImportButtonProps {
  disabled?: boolean
  /**
   * Reads the chosen export file. The caller parses and rebuilds the
   * conversation; the button only owns the file picker and its busy state.
   */
  onImport: (file: File) => Promise<void> | void
}

/**
 * Import entry of the conversation list: picks one exported JSON file and
 * hands it to the workspace. The file input stays hidden behind the button so
 * the control keeps a single accessible name.
 */
export function PlaygroundSessionImportButton(
  props: PlaygroundSessionImportButtonProps
) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset first so choosing the same file again still fires a change event.
    event.target.value = ''
    if (!file) return
    setImporting(true)
    try {
      await props.onImport(file)
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <Button
        aria-label={t('Import conversation')}
        disabled={props.disabled || importing}
        onClick={() => inputRef.current?.click()}
        size='icon'
        type='button'
        variant='outline'
      >
        {importing ? (
          <Loader2 aria-hidden='true' className='animate-spin' />
        ) : (
          <Upload aria-hidden='true' />
        )}
      </Button>
      <input
        accept='application/json,.json'
        aria-hidden='true'
        className='sr-only'
        onChange={(event) => void handleChange(event)}
        ref={inputRef}
        tabIndex={-1}
        type='file'
      />
    </>
  )
}
