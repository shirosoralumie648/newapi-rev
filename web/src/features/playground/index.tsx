import type { FileUIPart } from 'ai'
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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { CanvasSendDialog } from '@/features/canvas/components/canvas-send-dialog'
import {
  buildArtifactCanvasSeeds,
  buildMessageCanvasSeeds,
  type CanvasSendSeed,
} from '@/features/canvas/lib/canvas-send'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import type { PlaygroundArtifactSummary } from './artifact-api'
import { PlaygroundArtifactPanel } from './components/artifact/playground-artifact-panel'
import { PlaygroundArtifactSourceSheet } from './components/artifact/playground-artifact-source-sheet'
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundGenerationPanel } from './components/generation/playground-generation-panel'
import { PlaygroundInput } from './components/input/playground-input'
import { PlaygroundCanvasPanel } from './components/workspace/playground-canvas-panel'
import { PlaygroundUsagePopover } from './components/workspace/playground-usage-popover'
import {
  PlaygroundWorkspace,
  type PlaygroundInspectorView,
} from './components/workspace/playground-workspace'
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
  PLAYGROUND_ATTACHMENT_ERRORS,
  uploadPlaygroundAttachments,
} from './lib'
import type {
  Message,
  MessageAttachment,
  PlaygroundRouteTarget,
} from './types'

export function Playground(props: {
  target?: PlaygroundRouteTarget
  onOpenCanvas?: (projectId: string) => void
}) {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  return (
    <PlaygroundContent
      key={userId ?? 'signed-out'}
      target={props.target}
      onOpenCanvas={props.onOpenCanvas}
    />
  )
}

function PlaygroundContent(props: {
  target?: PlaygroundRouteTarget
  onOpenCanvas?: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [artifactSource, setArtifactSource] = useState<{
    message: Message
    source: CapturedArtifactSource
  } | null>(null)
  const [canvasSendSeeds, setCanvasSendSeeds] = useState<
    CanvasSendSeed[] | null
  >(null)
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [generationOpen, setGenerationOpen] = useState(false)
  const [canvasProjectId, setCanvasProjectId] = useState<string | null>(null)
  const appliedSessionRef = useRef<string | null>(null)
  const appliedArtifactRef = useRef<string | null>(null)
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
  // Sending a message snapshot to a canvas only needs the conversation to be
  // persisted; it does not mutate or require an idle generation.
  const canvasSendEnabled = Boolean(
    canonicalSessionId && activeSession?.server && !activeSession.syncPending
  )

  const {
    editingMessageKey,
    handleSendMessage,
    handleRegenerateMessage,
    handleEditMessage,
    handleEditOpenChange,
    applyEdit,
    handleDeleteMessage,
    handleSelectMessageVersion,
  } = usePlaygroundConversation({
    messages,
    updateMessages,
    sendChat,
  })

  const handleInputSubmit = useCallback(
    async (text: string, files: (FileUIPart & { id?: string })[] = []) => {
      if (files.length === 0) {
        handleSendMessage(text)
        return
      }
      const session = activeSession
      if (!session) {
        throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UPLOAD_FAILED)
      }
      let attachments: MessageAttachment[]
      try {
        const bound = await sync.ensureServerSession(session.id)
        if (!bound.server) {
          throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UPLOAD_FAILED)
        }
        attachments = await uploadPlaygroundAttachments(bound.server.id, files)
      } catch (error) {
        const serverMessage = getServerMessage(error)
        if (serverMessage) {
          toast.error(t(serverMessage))
        } else if (error instanceof Error && error.message) {
          toast.error(t(error.message))
        } else {
          toast.error(t(PLAYGROUND_ATTACHMENT_ERRORS.UPLOAD_FAILED))
        }
        throw error
      }
      handleSendMessage(text, attachments)
    },
    [activeSession, handleSendMessage, sync, t]
  )

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

  const handleSendMessageToCanvas = useCallback(
    (message: Message) => {
      if (!canvasSendEnabled || !canonicalSessionId) return
      const rawContent = getMessageContent(message)
      const visibleContent = getMessageContentState(
        message,
        rawContent
      ).displayContent
      const version = getCurrentVersion(message)
      const attachments = (version.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
      }))
      const seeds = buildMessageCanvasSeeds({
        sessionId: canonicalSessionId,
        messageKey: message.key,
        role: message.from,
        text: visibleContent,
        attachments,
      })
      if (seeds.length > 0) setCanvasSendSeeds(seeds)
    },
    [canvasSendEnabled, canonicalSessionId]
  )

  const handleSendArtifactToCanvas = useCallback(
    (artifact: PlaygroundArtifactSummary) => {
      setCanvasSendSeeds(
        buildArtifactCanvasSeeds({
          sessionId: artifact.session_id,
          artifactId: artifact.id,
          title: artifact.title,
        })
      )
    },
    []
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

  let inspectorView: PlaygroundInspectorView | null = null
  if (artifactController.state.isOpen) inspectorView = 'artifacts'
  else if (canvasOpen) inspectorView = 'canvas'
  else if (generationOpen) inspectorView = 'generate'

  const openCanvasInspector = useCallback(
    (projectId: string | null) => {
      const action = () => {
        artifactController.store.getState().setOpen(false)
        setGenerationOpen(false)
        setCanvasProjectId(projectId)
        setCanvasOpen(true)
      }
      if (artifactController.state.dirty) {
        artifactController.store.getState().requestDiscard(action)
        return
      }
      action()
    },
    [artifactController.state.dirty, artifactController.store]
  )

  const handleToggleInspector = useCallback(
    (view: PlaygroundInspectorView) => {
      if (view === 'artifacts') {
        if (artifactController.state.isOpen) {
          closeArtifactPanel()
          return
        }
        setCanvasOpen(false)
        setGenerationOpen(false)
        artifactController.store.getState().setOpen(true)
        return
      }
      if (view === 'canvas') {
        if (canvasOpen) {
          setCanvasOpen(false)
          return
        }
        setGenerationOpen(false)
        openCanvasInspector(canvasProjectId)
        return
      }
      if (generationOpen) {
        setGenerationOpen(false)
        return
      }
      const action = () => {
        artifactController.store.getState().setOpen(false)
        setCanvasOpen(false)
        setGenerationOpen(true)
      }
      if (artifactController.state.dirty) {
        artifactController.store.getState().requestDiscard(action)
        return
      }
      action()
    },
    [
      artifactController.state.dirty,
      artifactController.state.isOpen,
      artifactController.store,
      canvasOpen,
      canvasProjectId,
      closeArtifactPanel,
      generationOpen,
      openCanvasInspector,
    ]
  )

  const handleCloseInspector = useCallback(() => {
    if (artifactController.state.isOpen) {
      closeArtifactPanel()
      return
    }
    if (canvasOpen) {
      setCanvasOpen(false)
      return
    }
    setGenerationOpen(false)
  }, [artifactController.state.isOpen, canvasOpen, closeArtifactPanel])

  const handleOpenCanvasProject = useCallback(
    (projectId: string) => {
      props.onOpenCanvas?.(projectId)
    },
    [props.onOpenCanvas]
  )

  // After "Send to canvas", preview the canvas the nodes landed in so the user
  // can jump to the full editor from the chat workspace.
  const handleCanvasSent = useCallback(
    (project: { id: string }) => {
      openCanvasInspector(project.id)
    },
    [openCanvasInspector]
  )

  const requestedSession = props.target?.session
  useEffect(() => {
    if (!requestedSession || sync.isLoading) return
    const match = sessions.find(
      (session) => session.server?.id === requestedSession
    )
    if (!match) return
    if (appliedSessionRef.current === requestedSession) return
    appliedSessionRef.current = requestedSession
    if (match.id !== activeSessionId) handleSwitchSession(match.id)
  }, [
    activeSessionId,
    handleSwitchSession,
    requestedSession,
    sessions,
    sync.isLoading,
  ])

  const requestedArtifact = props.target?.artifact
  useEffect(() => {
    if (!requestedArtifact || !canonicalSessionId) return
    if (requestedSession && canonicalSessionId !== requestedSession) return
    if (appliedArtifactRef.current === requestedArtifact) return
    appliedArtifactRef.current = requestedArtifact
    setCanvasOpen(false)
    artifactController.store.getState().setOpen(true)
    artifactController.store.getState().selectArtifact(requestedArtifact)
  }, [
    canonicalSessionId,
    requestedArtifact,
    requestedSession,
    artifactController.store,
  ])

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
        usagePanel={
          userId ? <PlaygroundUsagePopover userId={userId} /> : undefined
        }
        inspectorView={inspectorView}
        artifactsDisabled={!canonicalSessionId}
        onToggleInspector={handleToggleInspector}
        onCloseInspector={handleCloseInspector}
        inspector={
          inspectorView === 'canvas' ? (
            <PlaygroundCanvasPanel
              activeProjectId={canvasProjectId}
              onOpenProject={handleOpenCanvasProject}
            />
          ) : inspectorView === 'generate' ? (
            <PlaygroundGenerationPanel
              active
              disabled={sync.isLoading}
              group={config.group}
              models={models}
              onSendToCanvas={(seeds) => setCanvasSendSeeds(seeds)}
            />
          ) : canonicalSessionId ? (
            <PlaygroundArtifactPanel
              controller={artifactController}
              onClose={closeArtifactPanel}
              onSendToCanvas={handleSendArtifactToCanvas}
            />
          ) : null
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
              onSelectVersion={handleSelectMessageVersion}
              onSelectPrompt={handleSendMessage}
              onCreateArtifact={
                artifactCreationEnabled ? openArtifactSource : undefined
              }
              onSendToCanvas={
                canvasSendEnabled ? handleSendMessageToCanvas : undefined
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
              onSubmit={handleInputSubmit}
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
      <CanvasSendDialog
        open={canvasSendSeeds !== null}
        onOpenChange={(open) => {
          if (!open) setCanvasSendSeeds(null)
        }}
        onSent={handleCanvasSent}
        seeds={canvasSendSeeds ?? []}
      />
    </>
  )
}
