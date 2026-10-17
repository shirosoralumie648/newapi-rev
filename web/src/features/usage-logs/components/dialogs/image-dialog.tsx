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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/http-client'

interface ImageDialogProps {
  imageUrl: string
  taskId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const protectedImagePathPrefix = '/mj/image/'

type ProtectedPreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

interface ProtectedPreview {
  src: string
  status: ProtectedPreviewStatus
}

function isProtectedImageUrl(imageUrl: string): boolean {
  if (imageUrl === '' || typeof window === 'undefined') return false
  try {
    const parsed = new URL(imageUrl, window.location.origin)
    return (
      parsed.origin === window.location.origin &&
      parsed.pathname.startsWith(protectedImagePathPrefix)
    )
  } catch {
    return false
  }
}

const idlePreview: ProtectedPreview = { src: '', status: 'idle' }

/**
 * Forwarded Midjourney image links need a login or an API token, but a plain
 * `<img>` cannot send the Authorization header. Same-origin links are fetched
 * with the shared axios client and displayed through an object URL; every other
 * URL keeps loading directly.
 */
function useProtectedImagePreview(
  imageUrl: string,
  enabled: boolean
): ProtectedPreview {
  const [preview, setPreview] = useState<ProtectedPreview>(idlePreview)

  useEffect(() => {
    if (!enabled || !isProtectedImageUrl(imageUrl)) {
      setPreview(idlePreview)
      return
    }

    let objectUrl = ''
    let cancelled = false
    const controller = new AbortController()
    setPreview({ src: '', status: 'loading' })

    void api
      .get(imageUrl, {
        responseType: 'blob',
        skipErrorHandler: true,
        disableDuplicate: true,
        signal: controller.signal,
      })
      .then((response) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(response.data as Blob)
        setPreview({ src: objectUrl, status: 'ready' })
      })
      .catch(() => {
        if (!cancelled) setPreview({ src: '', status: 'error' })
      })

    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
    }
  }, [imageUrl, enabled])

  return preview
}

export function ImageDialog({
  imageUrl,
  taskId,
  open,
  onOpenChange,
}: ImageDialogProps) {
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const protectedPreview = useProtectedImagePreview(imageUrl, open)
  // Decide from the current URL instead of the hook state so the raw protected
  // link is never rendered before the credentialed fetch starts.
  const previewRequiresCredentials = open && isProtectedImageUrl(imageUrl)
  const previewSrc = previewRequiresCredentials
    ? protectedPreview.src
    : imageUrl
  const showsSkeleton = previewRequiresCredentials
    ? protectedPreview.status !== 'ready' || isLoading
    : isLoading || hasError
  const showsError = previewRequiresCredentials
    ? protectedPreview.status === 'error'
    : hasError

  // Reset loading state when dialog opens or image URL changes
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      setIsLoading(true)
      setHasError(false)
    }
    onOpenChange(newOpen)
  }

  const handleImageLoad = () => {
    setIsLoading(false)
    setHasError(false)
  }

  const handleImageError = () => {
    setIsLoading(false)
    setHasError(true)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('Image Preview')}
      description={
        taskId ? `${t('Task ID:')} ${taskId}` : t('View the generated image')
      }
      contentClassName='sm:max-w-3xl'
      contentHeight='auto'
      bodyClassName='space-y-4'
    >
      <ScrollArea className='max-h-[600px]'>
        <div className='py-4'>
          <div className='bg-muted/50 relative flex min-h-[300px] items-center justify-center rounded-lg border'>
            {/* Skeleton - show when loading or error */}
            {showsSkeleton && (
              <Skeleton className='absolute inset-0 h-full w-full rounded-lg' />
            )}

            {/* Actual Image */}
            {previewSrc !== '' && (
              <img
                src={previewSrc}
                alt={t('Generated image')}
                className={`max-h-[550px] w-full rounded-lg object-contain ${
                  showsSkeleton ? 'opacity-0' : 'opacity-100'
                }`}
                onLoad={handleImageLoad}
                onError={handleImageError}
                loading='lazy'
              />
            )}

            {/* Error text overlay (shown on skeleton) */}
            {showsError && (
              <div className='absolute inset-0 flex items-center justify-center'>
                <p className='text-muted-foreground text-sm'>
                  {t('Failed to load image')}
                </p>
              </div>
            )}
          </div>

          {/* Image URL */}
          <div className='bg-muted mt-4 rounded-md p-3'>
            <p className='text-muted-foreground font-mono text-xs break-all'>
              {imageUrl}
            </p>
          </div>
        </div>
      </ScrollArea>
    </Dialog>
  )
}
