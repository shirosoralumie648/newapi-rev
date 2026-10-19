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
import type { FileUIPart } from 'ai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { restoreCanvasProject } from '@/features/canvas/api'
import { CanvasSendDialog } from '@/features/canvas/components/canvas-send-dialog'
import type {
  CanvasGenerationSearch,
  CanvasRouteSearch,
} from '@/features/canvas/lib/canvas-navigation'
import {
  buildMessageCanvasSeeds,
  type CanvasSendSeed,
} from '@/features/canvas/lib/canvas-send'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { PlaygroundArtifactSourceSheet } from './components/artifact/playground-artifact-source-sheet'
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundContextStatus } from './components/input/playground-context-status'
import { PlaygroundInput } from './components/input/playground-input'
import { PlaygroundSpeechDialog } from './components/message/playground-speech-dialog'
import { PlaygroundPresetPanel } from './components/workspace/playground-preset-panel'
import { PlaygroundSessionUsage } from './components/workspace/playground-session-usage'
import { PlaygroundTrashPanel } from './components/workspace/playground-trash-panel'
import { PlaygroundUsagePopover } from './components/workspace/playground-usage-popover'
import {
  PlaygroundWorkspace,
  type PlaygroundInspectorView,
} from './components/workspace/playground-workspace'
import {
  PLAYGROUND_PARALLEL_MIN_MODELS,
  PLAYGROUND_SPEECH_ERRORS,
} from './constants'
import {
  useChatHandler,
  useParallelChat,
  usePlaygroundContext,
  usePlaygroundConversation,
  usePlaygroundMessageCosts,
  usePlaygroundOptions,
  usePlaygroundArtifacts,
  usePlaygroundState,
  usePlaygroundServer,
} from './hooks'
import type { CapturedArtifactSource } from './hooks/use-playground-artifacts'
import {
  appendParallelMessagePair,
  collectMessageRequestIds,
  getCurrentVersion,
  getMessageContent,
  getMessageContentState,
  hasPendingToolCalls,
  PLAYGROUND_ATTACHMENT_ERRORS,
  presetSessionSettings,
  uploadPlaygroundAttachments,
  uploadPlaygroundSpeechAttachment,
} from './lib'
import type {
  AssistantPreset,
  Message,
  MessageAttachment,
  PlaygroundRouteTarget,
  PlaygroundSessionOrganization,
} from './types'

export function Playground(props: {
  target?: PlaygroundRouteTarget
  onOpenCanvas?: (search: CanvasRouteSearch) => void
  onOpenUpgrade?: () => void
}) {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  return (
    <PlaygroundContent
      key={userId ?? 'signed-out'}
      target={props.target}
      onOpenCanvas={props.onOpenCanvas}
      onOpenUpgrade={props.onOpenUpgrade}
    />
  )
}

function PlaygroundContent(props: {
  target?: PlaygroundRouteTarget
  onOpenCanvas?: (search: CanvasRouteSearch) => void
  onOpenUpgrade?: () => void
}) {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [artifactSource, setArtifactSource] = useState<{
    message: Message
    source: CapturedArtifactSource
  } | null>(null)
  // The message version the read-aloud dialog is working on: the audio it
  // generates is cached on exactly that version.
  const [speechSource, setSpeechSource] = useState<{
    messageKey: string
    versionId: string
    text: string
  } | null>(null)
  const [canvasSendSeeds, setCanvasSendSeeds] = useState<
    CanvasSendSeed[] | null
  >(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const appliedSessionRef = useRef<string | null>(null)
  const [compareModels, setCompareModels] = useState<string[]>([])
  const local = usePlaygroundState()
  const {
    config,
    parameterEnabled,
    systemPrompt,
    openingMessage,
    suggestedQuestions,
    context,
    contextSummary,
    messages,
    isLoadingMessages,
    models,
    groups,
    updateMessages,
    setModels,
    setGroups,
    updateConfig,
    updateParameterEnabled,
    updateSystemPrompt,
    updateContextSettings,
    updateContextSummary,
    applySessionSettings,
    clearMessages,
    sessions,
    activeSessionId,
    createSession,
    renameSession,
    organizeSession,
    switchSession,
  } = local

  // A composer submit can await an attachment upload before it appends, and a
  // comparison sends the snapshot it appended itself. The ref keeps both built
  // on the newest conversation even when the callback started a few awaits
  // earlier.
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const contextController = usePlaygroundContext({
    sessionId: activeSessionId,
    messages,
    config,
    systemPrompt,
    settings: context,
    summary: contextSummary,
    onSummaryChange: updateContextSummary,
  })

  const { sendChat, stopGeneration, isGenerating } = useChatHandler({
    config,
    parameterEnabled,
    systemPrompt,
    contextSettings: context,
    prepareContextSummary: contextController.prepareForSend,
    onMessageUpdate: updateMessages,
    sessionId: activeSessionId,
  })

  const {
    sendParallelChat,
    retryParallelVersion,
    stopComparison,
    isComparing,
  } = useParallelChat({
    config,
    parameterEnabled,
    systemPrompt,
    contextSettings: context,
    messages,
    prepareContextSummary: contextController.prepareForSend,
    onMessageUpdate: updateMessages,
    sessionId: activeSessionId,
  })

  // Every generated version keeps the relay request id of its request, so the
  // conversation can read the settled cost rows back in one bounded lookup.
  const messageRequestIds = useMemo(
    () => collectMessageRequestIds(messages),
    [messages]
  )
  const messageCostQuery = usePlaygroundMessageCosts(userId, messageRequestIds)
  const messageCosts = messageCostQuery.data?.costs

  // A running comparison writes the same snapshot through several requests, so
  // the autosave waits for it exactly like it waits for a streamed reply.
  const sync = usePlaygroundServer(local, isGenerating || isComparing)
  const deleteSession = sync.deleteSession
  const restoreSession = sync.restoreSession
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
    !isGenerating &&
    !isComparing
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
    handleProvideToolResult,
    handleDenyToolCall,
    handleContinueToolCalls,
  } = usePlaygroundConversation({
    messages,
    updateMessages,
    sendChat,
  })

  const pendingToolCalls = hasPendingToolCalls(messages)

  // The composer sends an ordinary reply unless the compare selection holds a
  // comparison; with one, the same turn goes to every selected model as its
  // own request and lands as a comparison group.
  const submitTurn = useCallback(
    (text: string, attachments?: MessageAttachment[]) => {
      if (compareModels.length < PLAYGROUND_PARALLEL_MIN_MODELS) {
        handleSendMessage(text, attachments)
        return
      }
      const nextMessages = appendParallelMessagePair(
        messagesRef.current,
        text,
        attachments,
        compareModels
      )
      updateMessages(nextMessages)
      sendParallelChat(nextMessages)
    },
    [compareModels, handleSendMessage, sendParallelChat, updateMessages]
  )

  const handleInputSubmit = useCallback(
    async (text: string, files: (FileUIPart & { id?: string })[] = []) => {
      if (files.length === 0) {
        submitTurn(text)
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
      submitTurn(text, attachments)
    },
    [activeSession, submitTurn, sync, t]
  )

  const handleStop = useCallback(() => {
    if (isComparing) stopComparison()
    if (isGenerating) stopGeneration()
  }, [isComparing, isGenerating, stopComparison, stopGeneration])

  const stopBeforeSessionChange = useCallback(() => {
    if (isComparing) stopComparison()
    if (isGenerating) stopGeneration()
  }, [isComparing, isGenerating, stopComparison, stopGeneration])

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

  // The settings a preset contributes to a conversation: its model, sampling
  // parameters, parameter flags and system prompt. Routing and transport stay
  // with the conversation the user configured.
  const sessionSettingsFromPreset = useCallback(
    (preset: AssistantPreset) =>
      presetSessionSettings(preset, { config, parameterEnabled }),
    [config, parameterEnabled]
  )

  const handleCreateSession = useCallback(() => {
    if (sync.isLoading) return
    handleWorkspaceTransition(() => {
      stopBeforeSessionChange()
      handleEditOpenChange(false)
      setArtifactSource(null)
      setSpeechSource(null)
      createSession()
    })
  }, [
    createSession,
    sync.isLoading,
    stopBeforeSessionChange,
    handleEditOpenChange,
    handleWorkspaceTransition,
  ])

  const handleCreateSessionWithPreset = useCallback(
    (preset: AssistantPreset) => {
      if (sync.isLoading) return
      handleWorkspaceTransition(() => {
        stopBeforeSessionChange()
        handleEditOpenChange(false)
        setArtifactSource(null)
        createSession(sessionSettingsFromPreset(preset))
        // The new conversation starts behind the inspector; on mobile the panel
        // is a sheet, so reveal the chat instead of leaving it covered.
        setPresetsOpen(false)
      })
    },
    [
      createSession,
      sessionSettingsFromPreset,
      sync.isLoading,
      stopBeforeSessionChange,
      handleEditOpenChange,
      handleWorkspaceTransition,
    ]
  )

  const handleApplyPreset = useCallback(
    (preset: AssistantPreset) => {
      applySessionSettings(sessionSettingsFromPreset(preset))
      toast.success(t('Preset applied'))
    },
    [applySessionSettings, sessionSettingsFromPreset, t]
  )

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

  const handleOrganizeSession = useCallback(
    (sessionId: string, organization: PlaygroundSessionOrganization) => {
      if (sync.isLoading) return
      organizeSession(sessionId, organization)
    },
    [organizeSession, sync.isLoading]
  )

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      if (sync.isLoading) return
      const trashed = sessions.some(
        (session) => session.id === sessionId && session.server != null
      )
      handleWorkspaceTransition(() => {
        if (sessionId === activeSessionId) {
          stopBeforeSessionChange()
          handleEditOpenChange(false)
          setArtifactSource(null)
          setSpeechSource(null)
        }
        deleteSession(sessionId)
        if (trashed) toast.success(t('Conversation moved to the trash'))
      })
    },
    [
      activeSessionId,
      deleteSession,
      sessions,
      sync.isLoading,
      stopBeforeSessionChange,
      handleEditOpenChange,
      handleWorkspaceTransition,
      t,
    ]
  )

  const handleClearMessages = () => {
    handleEditOpenChange(false)
    clearMessages()
  }

  // Undo the compression node. The stored messages were never removed, so the
  // next request simply carries the full history again.
  const handleRemoveContextSummary = useCallback(() => {
    updateContextSummary(null)
    toast.success(t('Context summary removed'))
  }, [updateContextSummary, t])

  const handleSummarizeContext = useCallback(() => {
    void contextController.summarizeNow()
  }, [contextController.summarizeNow])

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
        mediaType: attachment.mediaType,
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

  // The only generation entry in the conversation: a message action hands the
  // prompt and its reference images to the canvas editor, where the task node,
  // run and billing live.
  const handleGenerateFromMessage = useCallback(
    (message: Message, kind: 'image' | 'video') => {
      if (!canvasSendEnabled || !canonicalSessionId) return
      const visibleContent = getMessageContentState(
        message,
        getMessageContent(message)
      ).displayContent
      if (!visibleContent.trim()) return
      const version = getCurrentVersion(message)
      const attachmentIds = (version.attachments ?? [])
        .filter(
          (attachment) =>
            !attachment.mediaType || attachment.mediaType.startsWith('image/')
        )
        .slice(0, 4)
        .map((attachment) => attachment.id)
      const search: CanvasGenerationSearch = {
        prompt: visibleContent.slice(0, 4000),
        generate: kind,
        session: canonicalSessionId,
        message: message.key,
        ...(attachmentIds.length > 0
          ? { attachment: attachmentIds.join(',') }
          : {}),
      }
      props.onOpenCanvas?.(search)
    },
    [canvasSendEnabled, canonicalSessionId, props.onOpenCanvas]
  )

  // Read aloud works for any message with visible text; the audio is generated
  // through the relay and only cached on the conversation when the user saves
  // it, so opening the dialog never changes the workspace.
  const handleReadAloud = useCallback((message: Message) => {
    const visibleContent = getMessageContentState(
      message,
      getMessageContent(message)
    ).displayContent
    if (!visibleContent.trim()) return
    const version = getCurrentVersion(message)
    setSpeechSource({
      messageKey: message.key,
      versionId: version.id,
      text: visibleContent,
    })
  }, [])

  // Saving uploads the generated bytes as a conversation attachment and stores
  // the reference on the version the dialog was opened from, so the audio
  // survives a reload and keeps its stored bytes referenced.
  const handleSpeechSave = useCallback(
    async (blob: Blob) => {
      const session = activeSession
      const source = speechSource
      if (!session || !source) {
        throw new Error(PLAYGROUND_SPEECH_ERRORS.SAVE_FAILED)
      }
      const bound = await sync.ensureServerSession(session.id)
      if (!bound.server) {
        throw new Error(PLAYGROUND_SPEECH_ERRORS.SAVE_FAILED)
      }
      const speech = await uploadPlaygroundSpeechAttachment(
        bound.server.id,
        blob
      )
      updateMessages(
        messagesRef.current.map((message) => {
          if (message.key !== source.messageKey) return message
          return {
            ...message,
            versions: message.versions.map((version) =>
              version.id === source.versionId ? { ...version, speech } : version
            ),
          }
        })
      )
    },
    [activeSession, speechSource, sync, updateMessages]
  )

  const closeArtifactSource = useCallback((open: boolean) => {
    if (!open) setArtifactSource(null)
  }, [])

  // Creating an artifact from a message stays a conversation bridge: the
  // source sheet picks the reply content, then the saved artifact opens in the
  // canvas artifact browser where versions, sandbox preview and export live.
  const handleCreateArtifact = useCallback(
    async (
      selection: {
        kind: 'markdown' | 'code' | 'html' | 'svg'
        title: string
        language: string
        content: string
        codeBlockIndex?: number
      },
      source: CapturedArtifactSource
    ) => {
      const created = await artifactController.createFromSource(
        selection,
        source
      )
      if (!created) return false
      const artifactId = artifactController.store.getState().selectedArtifactId
      if (artifactId) {
        props.onOpenCanvas?.({
          session: source.sessionId,
          artifact: artifactId,
        })
      }
      return true
    },
    [
      artifactController.createFromSource,
      artifactController.store,
      props.onOpenCanvas,
    ]
  )

  let inspectorView: PlaygroundInspectorView | null = null
  if (presetsOpen) inspectorView = 'presets'
  else if (trashOpen) inspectorView = 'trash'

  const handleToggleInspector = useCallback((view: PlaygroundInspectorView) => {
    if (view === 'presets') {
      setTrashOpen(false)
      setPresetsOpen((current) => !current)
      return
    }
    setPresetsOpen(false)
    setTrashOpen((current) => !current)
  }, [])

  const handleCloseInspector = useCallback(() => {
    setPresetsOpen(false)
    setTrashOpen(false)
  }, [])

  const handleOpenPresets = useCallback(
    () => handleToggleInspector('presets'),
    [handleToggleInspector]
  )

  const handleOpenTrash = useCallback(
    () => handleToggleInspector('trash'),
    [handleToggleInspector]
  )

  const handleRestoreTrashedCanvas = useCallback(
    async (projectId: string) => {
      await restoreCanvasProject(projectId)
      toast.success(t('Canvas restored'))
    },
    [t]
  )

  const handleCanvasSent = useCallback(
    (project: { id: string }) => {
      props.onOpenCanvas?.({ project: project.id })
    },
    [props.onOpenCanvas]
  )

  // An old /playground?session=...&artifact=... link now opens the artifact in
  // the canvas artifact browser. The route paths and deep links stay unchanged.
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
    if (!requestedArtifact || !requestedSession) return
    props.onOpenCanvas?.({
      session: requestedSession,
      artifact: requestedArtifact,
    })
  }, [props.onOpenCanvas, requestedArtifact, requestedSession])

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
        onOpenPresets={handleOpenPresets}
        onOpenTrash={handleOpenTrash}
        onOrganize={handleOrganizeSession}
        onRename={renameSession}
        disabled={sync.isLoading}
        onSwitch={handleSwitchSession}
        sessions={sessions}
        usagePanel={
          userId ? (
            <PlaygroundUsagePopover
              userId={userId}
              onOpenUpgrade={props.onOpenUpgrade}
            />
          ) : undefined
        }
        syncLabel={syncLabel}
        inspectorView={inspectorView}
        onCloseInspector={handleCloseInspector}
        inspector={
          inspectorView === 'presets' ? (
            <PlaygroundPresetPanel
              active
              currentConfig={config}
              currentParameterEnabled={parameterEnabled}
              currentSystemPrompt={systemPrompt}
              currentOpeningMessage={openingMessage}
              currentSuggestedQuestions={suggestedQuestions}
              disabled={sync.isLoading}
              models={models}
              onApplyPreset={handleApplyPreset}
              onCreateSession={handleCreateSessionWithPreset}
            />
          ) : inspectorView === 'trash' ? (
            <PlaygroundTrashPanel
              onRestoreCanvas={handleRestoreTrashedCanvas}
              onRestoreSession={restoreSession}
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
          <PlaygroundSessionUsage
            className='shrink-0 pt-0'
            costs={messageCosts}
            messages={messages}
          />
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            <PlaygroundChat
              artifacts={artifactController.artifacts}
              messages={messages}
              costs={messageCosts}
              isLoadingMessages={isLoadingMessages || sync.isLoading}
              onRegenerateMessage={handleRegenerateMessage}
              onReadAloud={activeSession ? handleReadAloud : undefined}
              onEditMessage={handleEditMessage}
              onDeleteMessage={handleDeleteMessage}
              onSelectVersion={handleSelectMessageVersion}
              onSelectPrompt={submitTurn}
              onProvideToolResult={handleProvideToolResult}
              onDenyToolCall={handleDenyToolCall}
              onContinueToolCalls={handleContinueToolCalls}
              onRetryParallelVersion={retryParallelVersion}
              onCreateArtifact={
                artifactCreationEnabled ? openArtifactSource : undefined
              }
              onSendToCanvas={
                canvasSendEnabled ? handleSendMessageToCanvas : undefined
              }
              onGenerateMedia={
                canvasSendEnabled ? handleGenerateFromMessage : undefined
              }
              isGenerating={isGenerating || isComparing}
              editingKey={editingMessageKey}
              onCancelEdit={handleEditOpenChange}
              onSaveEdit={(newContent) => applyEdit(newContent, false)}
              onSaveEditAndSubmit={(newContent) => applyEdit(newContent, true)}
              contextSummary={contextSummary}
              openingMessage={openingMessage}
              suggestedQuestions={suggestedQuestions}
              onOpenArtifact={(artifact) =>
                props.onOpenCanvas?.({
                  session: artifact.session_id,
                  artifact: artifact.id,
                })
              }
              onRemoveContextSummary={handleRemoveContextSummary}
            />
          </div>

          <div className='mx-auto w-full max-w-4xl'>
            {pendingToolCalls && (
              <p
                role='status'
                className='text-muted-foreground px-1 pb-1 text-xs'
              >
                {t('Answer or deny the requested tool calls to continue.')}
              </p>
            )}
            <PlaygroundContextStatus
              className='pb-1'
              isSummarizing={contextController.isSummarizing}
              plan={contextController.plan}
              settings={context}
            />
            <PlaygroundInput
              config={config}
              contextPlan={contextController.plan}
              contextSettings={context}
              contextSummary={contextSummary}
              sessionId={activeSession?.id}
              disabled={
                isGenerating ||
                isComparing ||
                sync.isLoading ||
                pendingToolCalls ||
                contextController.isSummarizing
              }
              groups={groups}
              groupValue={config.group}
              isGenerating={isGenerating || isComparing}
              isModelLoading={isLoadingModels}
              isSummarizing={contextController.isSummarizing}
              modelValue={config.model}
              models={models}
              compareModels={compareModels}
              onCompareModelsChange={setCompareModels}
              onContextSettingsChange={updateContextSettings}
              onGroupChange={(value) => updateConfig('group', value)}
              onConfigChange={updateConfig}
              onClearMessages={handleClearMessages}
              onModelChange={(value) => updateConfig('model', value)}
              onParameterEnabledChange={updateParameterEnabled}
              onRemoveContextSummary={handleRemoveContextSummary}
              onStop={handleStop}
              onSubmit={handleInputSubmit}
              onSummarizeContext={handleSummarizeContext}
              onSystemPromptChange={updateSystemPrompt}
              parameterEnabled={parameterEnabled}
              systemPrompt={systemPrompt}
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
        onCreate={handleCreateArtifact}
      />
      <PlaygroundSpeechDialog
        group={config.group}
        models={models}
        onOpenChange={(open) => {
          if (!open) setSpeechSource(null)
        }}
        onSave={handleSpeechSave}
        open={speechSource !== null}
        text={speechSource?.text ?? ''}
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
