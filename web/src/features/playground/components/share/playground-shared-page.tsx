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
import { useQuery } from '@tanstack/react-query'
import { Link2Off } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import {
  getServerErrorMessage,
  getServerErrorMessageKey,
  getServerErrorStatus,
} from '@/lib/server-error-message'

import { getSharedPlaygroundTarget } from '../../share-api'
import { PlaygroundSharedCanvasView } from './playground-shared-canvas'
import { PlaygroundSharedConversationView } from './playground-shared-conversation'

interface PlaygroundSharedPageProps {
  /** Plaintext token taken from the public route. */
  token: string
}

/**
 * Anonymous read-only page for one share link. The response itself declares
 * whether the link points at a conversation or a canvas, so a link created
 * before canvas sharing existed keeps rendering through the conversation view.
 */
export function PlaygroundSharedPage(props: PlaygroundSharedPageProps) {
  const { t } = useTranslation()
  const shared = useQuery({
    queryKey: ['playground-shared-target', props.token],
    queryFn: ({ signal }) => getSharedPlaygroundTarget(props.token, signal),
    meta: { errorToast: false },
    retry: false,
  })

  if (shared.isPending) {
    return (
      <main className='bg-background text-foreground flex min-h-svh items-center justify-center px-4'>
        <LoadingState message={t('Loading shared link...')} />
      </main>
    )
  }

  if (shared.isError) {
    const notFound =
      getServerErrorStatus(shared.error) === 404 ||
      getServerErrorMessageKey(shared.error) ===
        'Shared conversation not found.'
    return (
      <main className='bg-background text-foreground flex min-h-svh items-center justify-center px-4'>
        <ErrorState
          className='w-full max-w-xl'
          description={
            notFound
              ? t('This link may have been revoked or has expired.')
              : getServerErrorMessage(
                  shared.error,
                  t('Please try again later.')
                )
          }
          icon={notFound ? Link2Off : undefined}
          onRetry={notFound ? undefined : () => void shared.refetch()}
          title={
            notFound
              ? t('Shared link not found')
              : t('Unable to load the shared link')
          }
        />
      </main>
    )
  }

  if (shared.data.kind === 'canvas') {
    return <PlaygroundSharedCanvasView canvas={shared.data.canvas} />
  }
  return (
    <PlaygroundSharedConversationView conversation={shared.data.conversation} />
  )
}
