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
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { PlaygroundArtifactPanel } from './components/artifact/playground-artifact-panel'
import { PlaygroundArtifactSourceSheet } from './components/artifact/playground-artifact-source-sheet'
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundInput } from './components/input/playground-input'
import { PlaygroundWorkspace } from './components/workspace/playground-workspace'
import {
  useChatHandler,
  usePlaygroundConversation,
  usePlaygroundOptions,
  usePlaygroundArtifacts,
  usePlaygroundState,
  usePlaygroundServer,
} from './hooks'
import type { CapturedArtifactSource } from './hooks/use-playground-artifacts'
import {
  getCurrentVersion,
  getMessageContent,
  getMessageContentState,
} from './lib'
import type { Message } from './types'

export function Playground() {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  return <PlaygroundContent key={userId ?? 'signed-out'} />
}

function PlaygroundContent() {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [artifactSource, setArtifactSource] = useState<{
    message: Message
    source: CapturedArtifactSource
  } | null>(null)
  const local = usePlaygroundState()
  const {
    config,
    parameterEnabled,
    messages,
    isLoadingMessages,
    models,
    groups,
    updateMessages,
    setModels,
    setGroups,
    updateConfig,
    updateParameterEnabled,
    clearMessages,
    sessions,
    activeSessionId,
    createSession,
    renameSession,
    switchSession,
  } = local

  const { sendChat, stopGeneration, isGenerating } = useChatHandler({
    config,
    parameterEnabled,
    onMessageUpdate: updateMessages,
    sessionId: activeSessionId,
  })

  const sync = usePlaygroundServer(local, isGenerating)
  const deleteSession = sync.deleteSession
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId
  )
  const canonicalSessionId = activeSession?.server?.id ?? null
  const artifactController = usePlaygroundArtifacts(userId, canonicalSessionId)
  const artifactCreationEnabled = Boolean(
    canonicalSessionId &&
    activeSession?.server &&
    !activeSession.syncPending &&
    !sync.isLoading &&
    !sync.isSaving &&
    !sync.error &&
    !isGenerating
  )

  const {
    editingMessageKey,
    handleSendMessage,
    handleRegenerateMessage,
    handleEditMessage,
    handleEditOpenChange,
    applyEdit,
    handleDeleteMessage,
  } = usePlaygroundConversation({
    messages,
    updateMessages,
    sendChat,
  })

  const stopBeforeSessionChange = useCallback(() => {
    if (isGenerating) stopGeneration()
  }, [isGenerating, stopGeneration])

  const handleWorkspaceTransition = useCallback(
    (action: () => void) => {
      if (artifactController.state.dirty) {
        artifactController.store.getState().requestDiscard(action)
        return
      }
      action()
    },
    [artifactController.state.dirty, artifactController.store]
  )

  const handleCreateSession = useCallback(() => {
    if (sync.isLoading) return
    handleWorkspaceTransition(() => {
      stopBeforeSessionChange()
      handleEditOpenChange(false)
      setArtifactSource(null)
      createSession()
    })
  }, [
    createSession,
    sync.isLoading,
    stopBeforeSessionChange,
    handleEditOpenChange,
    handleWorkspaceTransition,
  ])

  const handleSwitchSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId || sync.isLoading) return
      handleWorkspaceTransition(() => {
        stopBeforeSessionChange()
        handleEditOpenChange(false)
        setArtifactSource(null)
        switchSession(sessionId)
      })
    },
    [
      activeSessionId,
      sync.isLoading,
      stopBeforeSessionChange,
      handleEditOpenChange,
      switchSession,
      handleWorkspaceTransition,
    ]
  )

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      if (sync.isLoading) return
      handleWorkspaceTransition(() => {
        if (sessionId === activeSessionId) {
          stopBeforeSessionChange()
          handleEditOpenChange(false)
          setArtifactSource(null)
        }
        deleteSession(sessionId)
      })
    },
    [
      activeSessionId,
      deleteSession,
      sync.isLoading,
      stopBeforeSessionChange,
      handleEditOpenChange,
      handleWorkspaceTransition,
    ]
  )

  const handleClearMessages = () => {
    handleEditOpenChange(false)
    clearMessages()
  }

  const openArtifactSource = useCallback(
    (message: Message) => {
      if (
        !artifactCreationEnabled ||
        !userId ||
        !canonicalSessionId ||
        !activeSession?.server
      ) {
        return
      }
      if (
        message.from !== 'assistant' ||
        message.status === 'error' ||
        message.status === 'loading' ||
        message.status === 'streaming' ||
        message.isContentComplete === false
      ) {
        return
      }
      const rawContent = getMessageContent(message)
      const visibleContent = getMessageContentState(
        message,
        rawContent
      ).displayContent
      if (!visibleContent.trim()) return
      const version = getCurrentVersion(message)
      const captured: CapturedArtifactSource = {
        ownerId: userId,
        sessionId: canonicalSessionId,
        messageKey: message.key,
        versionId: version.id,
        messageRevision: activeSession.server.messageRevision,
        rawContent,
        visibleContent,
      }
      const action = () => setArtifactSource({ message, source: captured })
      if (artifactController.state.dirty) {
        artifactController.store.getState().requestDiscard(action)
        return
      }
      action()
    },
    [
      activeSession,
      artifactController.state.dirty,
      artifactController.store,
      artifactCreationEnabled,
      canonicalSessionId,
      userId,
    ]
  )

  const closeArtifactPanel = useCallback(() => {
    if (artifactController.state.dirty) {
      artifactController.store
        .getState()
        .requestDiscard(() =>
          artifactController.store.getState().setOpen(false)
        )
      return
    }
    artifactController.store.getState().setOpen(false)
  }, [artifactController.state.dirty, artifactController.store])

  const closeArtifactSource = useCallback((open: boolean) => {
    if (!open) setArtifactSource(null)
  }, [])

  const updateLoadedConfig = useCallback<typeof updateConfig>(
    (key, value) => {
      if (!sync.isLoading) updateConfig(key, value)
    },
    [sync.isLoading, updateConfig]
  )

  const { isLoadingModels } = usePlaygroundOptions({
    currentGroup: config.group,
    currentModel: config.model,
    setGroups,
    setModels,
    updateConfig: updateLoadedConfig,
  })

  let syncLabel = t('Playground')
  if (sync.isLoading) syncLabel = t('Loading conversations...')
  else if (sync.isSaving) syncLabel = t('Saving conversation...')

  return (
    <>
      <PlaygroundWorkspace
        activeSessionId={activeSessionId}
        onCreate={handleCreateSession}
        onDelete={handleDeleteSession}
        onRename={renameSession}
        disabled={sync.isLoading}
        onSwitch={handleSwitchSession}
        sessions={sessions}
        artifactsOpen={artifactController.state.isOpen}
        artifactDisabled={!canonicalSessionId}
        onToggleArtifacts={() => {
          if (artifactController.state.isOpen) {
            closeArtifactPanel()
          } else {
            artifactController.store.getState().setOpen(true)
          }
        }}
        onCloseArtifacts={closeArtifactPanel}
        artifactPanel={
          canonicalSessionId ? (
            <PlaygroundArtifactPanel
              controller={artifactController}
              onClose={closeArtifactPanel}
            />
          ) : undefined
        }
      >
        <div className='relative flex size-full min-h-0 flex-col overflow-hidden'>
          {sync.error && (
            <div role='alert' className='shrink-0'>
              <ErrorState
                className='min-h-0 p-3'
                title={t(
                  'Conversation sync failed. Your draft is kept locally.'
                )}
                description={getServerMessage(sync.error)}
                onRetry={sync.retry}
                action={
                  sync.conflict ? (
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={isGenerating}
                      onClick={sync.saveAsNew}
                    >
                      {t('Keep draft as a new conversation')}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
          {(sync.cacheError || local.persistenceError) && (
            <p role='alert' className='px-4 text-sm'>
              {t(
                'Browser storage is unavailable. Keep this page open until synchronization finishes.'
              )}
            </p>
          )}
          <p
            role='status'
            className='text-muted-foreground shrink-0 px-4 py-1 text-xs'
          >
            {syncLabel}
          </p>
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            <PlaygroundChat
              messages={messages}
              isLoadingMessages={isLoadingMessages || sync.isLoading}
              onRegenerateMessage={handleRegenerateMessage}
              onEditMessage={handleEditMessage}
              onDeleteMessage={handleDeleteMessage}
              onSelectPrompt={handleSendMessage}
              onCreateArtifact={
                artifactCreationEnabled ? openArtifactSource : undefined
              }
              isGenerating={isGenerating}
              editingKey={editingMessageKey}
              onCancelEdit={handleEditOpenChange}
              onSaveEdit={(newContent) => applyEdit(newContent, false)}
              onSaveEditAndSubmit={(newContent) => applyEdit(newContent, true)}
            />
          </div>

          <div className='mx-auto w-full max-w-4xl'>
            <PlaygroundInput
              config={config}
              disabled={isGenerating || sync.isLoading}
              groups={groups}
              groupValue={config.group}
              isGenerating={isGenerating}
              isModelLoading={isLoadingModels}
              modelValue={config.model}
              models={models}
              onGroupChange={(value) => updateConfig('group', value)}
              onConfigChange={updateConfig}
              onClearMessages={handleClearMessages}
              onModelChange={(value) => updateConfig('model', value)}
              onParameterEnabledChange={updateParameterEnabled}
              onStop={stopGeneration}
              onSubmit={handleSendMessage}
              parameterEnabled={parameterEnabled}
              hasMessages={messages.length > 0}
            />
          </div>
        </div>
      </PlaygroundWorkspace>
      <PlaygroundArtifactSourceSheet
        source={artifactSource?.source ?? null}
        isSaving={artifactController.isSaving}
        error={artifactController.error}
        hasRetry={artifactController.state.pendingCreate !== null}
        onRetry={artifactController.retryCreate}
        onOpenChange={closeArtifactSource}
        onCreate={artifactController.createFromSource}
      />
    </>
  )
}
