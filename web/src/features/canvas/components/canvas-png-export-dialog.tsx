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
import { Download, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

import type { CanvasPngExportResult } from '../lib/canvas-export'

interface CanvasPngExportDialogProps {
  open: boolean
  result: CanvasPngExportResult | null
  saving: boolean
  saved: boolean
  onOpenChange: (open: boolean) => void
  onDownload: () => void
  onSave: () => void
}

/** Preview and actions for a locally rendered PNG of the canvas. */
export function CanvasPngExportDialog(props: CanvasPngExportDialogProps) {
  const { t } = useTranslation()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!props.result) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(props.result.blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [props.result])

  if (!props.result) return null

  return (
    <Dialog
      description={t('A PNG image of the canvas nodes and connections.')}
      footer={
        <>
          <Button
            onClick={() => props.onOpenChange(false)}
            type='button'
            variant='outline'
          >
            {t('Close')}
          </Button>
          <Button
            disabled={props.saving || props.saved}
            onClick={props.onSave}
            type='button'
            variant='outline'
          >
            {props.saving ? (
              <Spinner aria-hidden='true' />
            ) : (
              <Save aria-hidden='true' />
            )}
            {props.saved ? t('Saved to library') : t('Save to library')}
          </Button>
          <Button onClick={props.onDownload} type='button'>
            <Download aria-hidden='true' />
            {t('Download PNG')}
          </Button>
        </>
      }
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={t('Export PNG')}
    >
      <div className='bg-muted/40 flex min-h-48 items-center justify-center rounded-lg border p-3'>
        {previewUrl ? (
          <img
            alt={t('PNG preview')}
            className='max-h-[50vh] max-w-full rounded object-contain shadow-sm'
            src={previewUrl}
          />
        ) : (
          <Spinner aria-hidden='true' />
        )}
      </div>
      <p className='text-muted-foreground mt-2 text-xs'>
        {t('{{width}} × {{height}} px', {
          width: props.result.width,
          height: props.result.height,
        })}
      </p>
    </Dialog>
  )
}
