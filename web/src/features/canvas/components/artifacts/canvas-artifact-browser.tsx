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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { getPlaygroundSessions } from '@/features/playground/api'
import type { PlaygroundArtifactSummary } from '@/features/playground/artifact-api'
import { usePlaygroundArtifacts } from '@/features/playground/hooks'
import { getServerMessage } from '@/lib/server-error-message'

import { CanvasArtifactPanel } from './canvas-artifact-panel'

interface CanvasArtifactBrowserProps {
  active: boolean
  userId: number | null
  /** Conversation the artifact browser opens, e.g. one chat created an artifact in. */
  initialSessionId?: string
  /** Artifact selected after a chat creation or a canvas deep link. */
  initialArtifactId?: string
  onAddToCanvas: (artifact: PlaygroundArtifactSummary) => void
  onClose: () => void
}

/**
 * The canvas artifact browser. Artifacts stay stored inside their source
 * conversation, so the browser picks a conversation and then reuses the same
 * version editor, sandboxed preview and export actions the Playground used to
 * host. The result is added to the current canvas as an artifact node.
 */
export function CanvasArtifactBrowser(props: CanvasArtifactBrowserProps) {
  const { t } = useTranslation()
  const [sessionId, setSessionId] = useState<string | null>(
    props.initialSessionId ?? null
  )
  const sessionsQuery = useQuery({
    queryKey: ['playground', props.userId, 'canvas-artifact-sessions'],
    queryFn: ({ signal }) => getPlaygroundSessions(signal),
    enabled: props.active && props.userId !== null,
    retry: false,
    meta: { errorToast: false },
  })
  const controller = usePlaygroundArtifacts(props.userId, sessionId)
  const store = controller.store

  useEffect(() => {
    if (props.initialSessionId) setSessionId(props.initialSessionId)
  }, [props.initialSessionId])

  useEffect(() => {
    if (sessionId) return
    const first = sessionsQuery.data?.[0]
    if (first) setSessionId(first.id)
  }, [sessionId, sessionsQuery.data])

  useEffect(() => {
    if (!props.initialArtifactId || !sessionId) return
    if (props.initialSessionId && props.initialSessionId !== sessionId) return
    const current = store.getState()
    if (current.selectedArtifactId !== props.initialArtifactId) {
      current.selectArtifact(props.initialArtifactId)
    }
  }, [props.initialArtifactId, props.initialSessionId, sessionId, store])

  const sessions = sessionsQuery.data ?? []
  const options: { id: string; title: string }[] = sessions.map((session) => ({
    id: session.id,
    title: session.title,
  }))
  if (
    props.initialSessionId &&
    !options.some((session) => session.id === props.initialSessionId)
  ) {
    options.unshift({
      id: props.initialSessionId,
      title: props.initialSessionId,
    })
  }

  let content = (
    <EmptyState
      className='min-h-40'
      description={t(
        'Artifacts created from assistant responses will appear here.'
      )}
      title={t('No assets yet')}
    />
  )
  if (sessionsQuery.isLoading) {
    content = <LoadingState className='min-h-40' />
  } else if (sessionsQuery.isError) {
    content = (
      <ErrorState
        className='min-h-0'
        description={getServerMessage(sessionsQuery.error)}
        onRetry={() => void sessionsQuery.refetch()}
        title={t('Unable to load conversations.')}
      />
    )
  } else if (sessionId) {
    content = (
      <CanvasArtifactPanel
        controller={controller}
        onClose={props.onClose}
        onSendToCanvas={props.onAddToCanvas}
      />
    )
  }

  return (
    <div
      className='flex h-full min-h-0 flex-col'
      data-tour='canvas-artifact-browser'
    >
      <div className='grid shrink-0 gap-1 border-b px-3 py-2'>
        <Label
          className='text-muted-foreground text-xs'
          htmlFor='canvas-artifact-session'
        >
          {t('Session')}
        </Label>
        <NativeSelect
          aria-label={t('Session')}
          disabled={options.length === 0}
          id='canvas-artifact-session'
          onChange={(event) => setSessionId(event.target.value)}
          size='sm'
          value={sessionId ?? ''}
        >
          {options.length === 0 ? (
            <NativeSelectOption value=''>
              {t('No conversations yet')}
            </NativeSelectOption>
          ) : null}
          {options.map((session) => (
            <NativeSelectOption key={session.id} value={session.id}>
              {session.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className='min-h-0 flex-1'>{content}</div>
    </div>
  )
}
