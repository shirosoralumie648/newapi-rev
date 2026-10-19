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
import { Link2Off, Paperclip, Share2, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import {
  getServerErrorMessage,
  getServerErrorMessageKey,
  getServerErrorStatus,
} from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import { getSharedPlaygroundConversation } from '../../share-api'
import type {
  MessageToolCallStatus,
  PlaygroundSharedMessage,
} from '../../types'

interface PlaygroundSharedConversationProps {
  /** Plaintext token taken from the public route. */
  token: string
}

/**
 * Anonymous read-only view of one shared conversation. The server already
 * stripped private fields; this component renders text, tool-call summaries and
 * attachment placeholders as plain React text. It never renders markdown HTML
 * and never requests attachment bytes.
 */
export function PlaygroundSharedConversation(
  props: PlaygroundSharedConversationProps
) {
  const { t } = useTranslation()
  const conversation = useQuery({
    queryKey: ['playground-shared-conversation', props.token],
    queryFn: ({ signal }) =>
      getSharedPlaygroundConversation(props.token, signal),
    meta: { errorToast: false },
    retry: false,
  })

  if (conversation.isPending) {
    return (
      <main className='bg-background text-foreground flex min-h-svh items-center justify-center px-4'>
        <LoadingState message={t('Loading shared conversation...')} />
      </main>
    )
  }

  if (conversation.isError) {
    const notFound =
      getServerErrorStatus(conversation.error) === 404 ||
      getServerErrorMessageKey(conversation.error) ===
        'Shared conversation not found.'
    return (
      <main className='bg-background text-foreground flex min-h-svh items-center justify-center px-4'>
        <ErrorState
          className='w-full max-w-xl'
          description={
            notFound
              ? t('This link may have been revoked or has expired.')
              : getServerErrorMessage(
                  conversation.error,
                  t('Please try again later.')
                )
          }
          icon={notFound ? Link2Off : undefined}
          onRetry={notFound ? undefined : () => void conversation.refetch()}
          title={
            notFound
              ? t('Shared conversation not found')
              : t('Unable to load the shared conversation')
          }
        />
      </main>
    )
  }

  const data = conversation.data
  return (
    <main className='bg-background text-foreground min-h-svh px-4 py-8 sm:px-6 sm:py-12'>
      <article className='mx-auto flex w-full max-w-3xl flex-col gap-6'>
        <header className='flex flex-col gap-3 border-b pb-6'>
          <div className='text-muted-foreground flex items-center gap-2 text-sm'>
            <Share2 aria-hidden='true' className='size-4' />
            <span>{t('Read-only shared conversation')}</span>
          </div>
          <h1 className='text-2xl font-semibold break-words sm:text-3xl'>
            {data.title.trim() || t('Untitled conversation')}
          </h1>
          <p className='text-muted-foreground text-sm'>
            {t(
              'This is a read-only copy shared by a Playground user. Attachments and tool call details are not included.'
            )}
          </p>
        </header>

        {data.openingMessage.trim() ? (
          <section className='bg-muted/40 rounded-xl border p-4'>
            <h2 className='mb-2 text-sm font-medium'>{t('Opening message')}</h2>
            <p className='text-sm leading-6 break-words whitespace-pre-wrap'>
              {data.openingMessage}
            </p>
          </section>
        ) : null}

        {data.messages.length === 0 ? (
          <EmptyState
            bordered
            description={t('The shared conversation has no messages yet.')}
            title={t('No messages')}
          />
        ) : (
          <section
            aria-label={t('Shared messages')}
            className='flex flex-col gap-4'
          >
            {data.messages.map((message) => (
              <SharedMessage key={message.key} message={message} />
            ))}
          </section>
        )}

        <footer className='text-muted-foreground border-t pt-4 text-center text-xs'>
          {t(
            'The owner of this conversation can revoke this link at any time.'
          )}
        </footer>
      </article>
    </main>
  )
}

function SharedMessage(props: { message: PlaygroundSharedMessage }) {
  const { t } = useTranslation()
  const statusLabels: Record<MessageToolCallStatus, string> = {
    pending: t('Pending'),
    completed: t('Completed'),
    denied: t('Denied'),
    error: t('Failed'),
  }
  const isUser = props.message.from === 'user'

  return (
    <article
      className={cn(
        'rounded-xl border p-4',
        isUser ? 'bg-muted/50' : 'bg-card'
      )}
    >
      <h2 className='mb-2 text-sm font-medium'>
        {isUser ? t('You') : t('Assistant')}
      </h2>
      {props.message.content ? (
        <p className='text-sm leading-6 break-words whitespace-pre-wrap'>
          {props.message.content}
        </p>
      ) : null}

      {props.message.toolCalls.length > 0 ? (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <Wrench aria-hidden='true' className='text-muted-foreground size-4' />
          {props.message.toolCalls.map((toolCall, index) => (
            <Badge
              key={`${toolCall.name}-${index}`}
              variant={toolCall.status === 'error' ? 'destructive' : 'outline'}
            >
              {toolCall.name} · {statusLabels[toolCall.status]}
            </Badge>
          ))}
        </div>
      ) : null}

      {props.message.attachments.length > 0 ? (
        <div className='mt-3 grid gap-2'>
          {props.message.attachments.map((attachment, index) => (
            <div
              className='flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2 text-sm'
              key={`${attachment.filename ?? 'attachment'}-${index}`}
            >
              <Paperclip
                aria-hidden='true'
                className='text-muted-foreground size-4'
              />
              <span className='font-medium'>
                {attachment.filename || t('Attachment')}
              </span>
              {attachment.mediaType ? (
                <span className='text-muted-foreground'>
                  {attachment.mediaType}
                </span>
              ) : null}
            </div>
          ))}
          <p className='text-muted-foreground text-xs'>
            {t('Attachment content is not available in shared conversations.')}
          </p>
        </div>
      ) : null}
    </article>
  )
}
