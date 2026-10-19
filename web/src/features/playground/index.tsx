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
import {
  buildArtifactCanvasSeeds,
  buildAttachmentCanvasSeeds,
  buildMessageCanvasSeeds,
  type CanvasSendSeed,
} from '@/features/canvas/lib/canvas-send'
import { handleServerError } from '@/lib/handle-server-error'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { playgroundAttachmentContentUrl } from './api'
import {
  getPlaygroundArtifact,
  type PlaygroundArtifactSummary,
} from './artifact-api'
import type { PlaygroundAssetItem } from './asset-api'
import { PlaygroundArtifactPanel } from './components/artifact/playground-artifact-panel'
import { PlaygroundArtifactSourceSheet } from './components/artifact/playground-artifact-source-sheet'
import { PlaygroundAssetLibrary } from './components/asset/playground-asset-library'
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundGenerationPanel } from './components/generation/playground-generation-panel'
import { PlaygroundContextStatus } from './components/input/playground-context-status'
import { PlaygroundInput } from './components/input/playground-input'
import { PlaygroundSpeechDialog } from './components/message/playground-speech-dialog'
import { PlaygroundCanvasPanel } from './components/workspace/playground-canvas-panel'
import { PlaygroundMemoryPanel } from './components/workspace/playground-memory-panel'
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
  usePlaygroundMemories,
  usePlaygroundMemoryExtraction,
  usePlaygroundOptions,
  usePlaygroundArtifacts,
  usePlaygroundState,
  usePlaygroundServer,
} from './hooks'
import type { CapturedArtifactSource } from './hooks/use-playground-artifacts'
import {
  appendParallelMessagePair,
  collectMessageRequestIds,
  formatMemoryBlock,
  getCurrentVersion,
  getMessageContent,
  getMessageContentState,
  hasPendingToolCalls,
  loadMemoryExtractionSettings,
  loadPlaygroundAttachment,
  PLAYGROUND_ATTACHMENT_ERRORS,
  presetSessionSettings,
  saveMemoryExtractionSettings,
  uploadPlaygroundAttachments,
  uploadPlaygroundSpeechAttachment,
} from './lib'
import type {
  AssistantPreset,
  Message,
  MessageAttachment,
  PlaygroundMemoryExtractionSettings,
  PlaygroundRouteTarget,
} from './types'

export function Playground(props: {
  target?: PlaygroundRouteTarget
  onOpenCanvas?: (projectId: string) => void
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
  onOpenCanvas?: (projectId: string) => void
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
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [generationOpen, setGenerationOpen] = useState(false)
  const [canvasProjectId, setCanvasProjectId] = useState<string | null>(null)
  const [canvasRefreshSignal, setCanvasRefreshSignal] = useState(0)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [pendingLibraryFiles, setPendingLibraryFiles] = useState<File[]>([])
  const [pendingLibraryText, setPendingLibraryText] = useState<string | null>(
    null
  )
  const appliedSessionRef = useRef<string | null>(null)
  const appliedArtifactRef = useRef<string | null>(null)
  const [compareModels, setCompareModels] = useState<string[]>([])
  const local = usePlaygroundState()
  const {
    config,
    parameterEnabled,
    systemPrompt,
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
    switchSession,
  } = local

  // A composer submit can await an attachment upload before it appends, and a
  // comparison sends the snapshot it appended itself. The ref keeps both built
  // on the newest conversation even when the callback started a few awaits
  // earlier.
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Cross-session memory: every enabled note of the account is injected after
  // the system prompt, and extraction is opt-in per account.
  const memoriesQuery = usePlaygroundMemories(userId)
  const memoryBlock = useMemo(
    () => formatMemoryBlock(memoriesQuery.data?.items ?? []),
    [memoriesQuery.data]
  )
  const [memoryExtraction, setMemoryExtraction] =
    useState<PlaygroundMemoryExtractionSettings>(() =>
      loadMemoryExtractionSettings(userId)
    )
  const handleMemoryExtractionChange = useCallback(
    (settings: PlaygroundMemoryExtractionSettings) => {
      setMemoryExtraction(settings)
      saveMemoryExtractionSettings(userId, settings)
    },
    [userId]
  )

  const contextController = usePlaygroundContext({
    sessionId: activeSessionId,
    messages,
    config,
    systemPrompt,
    memoryBlock,
    settings: context,
    summary: contextSummary,
    onSummaryChange: updateContextSummary,
  })

  const { sendChat, stopGeneration, isGenerating } = useChatHandler({
    config,
    parameterEnabled,
    systemPrompt,
    memoryBlock,
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
    memoryBlock,
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

  // The extraction runs when a reply or comparison stops being busy; the hook
  // keeps its own per-reply guard, so a re-render or a late message update does
  // not call the billed extraction twice for the same answer.
  usePlaygroundMemoryExtraction({
    userId,
    config,
    contextSettings: context,
    settings: memoryExtraction,
    messages,
    sourceSessionId: canonicalSessionId,
    isBusy: isGenerating || isComparing,
  })

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
  else if (libraryOpen) inspectorView = 'library'
  else if (memoryOpen) inspectorView = 'memory'
  else if (presetsOpen) inspectorView = 'presets'
  else if (trashOpen) inspectorView = 'trash'

  const openCanvasInspector = useCallback(
    (projectId: string | null) => {
      const action = () => {
        artifactController.store.getState().setOpen(false)
        setGenerationOpen(false)
        setLibraryOpen(false)
        setMemoryOpen(false)
        setPresetsOpen(false)
        setTrashOpen(false)
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
        setLibraryOpen(false)
        setMemoryOpen(false)
        setPresetsOpen(false)
        setTrashOpen(false)
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
      if (view === 'library') {
        if (libraryOpen) {
          setLibraryOpen(false)
          return
        }
        const openLibrary = () => {
          artifactController.store.getState().setOpen(false)
          setCanvasOpen(false)
          setGenerationOpen(false)
          setMemoryOpen(false)
          setPresetsOpen(false)
          setTrashOpen(false)
          setLibraryOpen(true)
        }
        if (artifactController.state.dirty) {
          artifactController.store.getState().requestDiscard(openLibrary)
          return
        }
        openLibrary()
        return
      }
      if (view === 'memory') {
        if (memoryOpen) {
          setMemoryOpen(false)
          return
        }
        const openMemory = () => {
          artifactController.store.getState().setOpen(false)
          setCanvasOpen(false)
          setGenerationOpen(false)
          setLibraryOpen(false)
          setPresetsOpen(false)
          setTrashOpen(false)
          setMemoryOpen(true)
        }
        if (artifactController.state.dirty) {
          artifactController.store.getState().requestDiscard(openMemory)
          return
        }
        openMemory()
        return
      }
      if (view === 'presets') {
        if (presetsOpen) {
          setPresetsOpen(false)
          return
        }
        const openPresets = () => {
          artifactController.store.getState().setOpen(false)
          setCanvasOpen(false)
          setGenerationOpen(false)
          setLibraryOpen(false)
          setMemoryOpen(false)
          setTrashOpen(false)
          setPresetsOpen(true)
        }
        if (artifactController.state.dirty) {
          artifactController.store.getState().requestDiscard(openPresets)
          return
        }
        openPresets()
        return
      }
      if (view === 'trash') {
        if (trashOpen) {
          setTrashOpen(false)
          return
        }
        const openTrash = () => {
          artifactController.store.getState().setOpen(false)
          setCanvasOpen(false)
          setGenerationOpen(false)
          setLibraryOpen(false)
          setMemoryOpen(false)
          setPresetsOpen(false)
          setTrashOpen(true)
        }
        if (artifactController.state.dirty) {
          artifactController.store.getState().requestDiscard(openTrash)
          return
        }
        openTrash()
        return
      }
      if (generationOpen) {
        setGenerationOpen(false)
        return
      }
      const action = () => {
        artifactController.store.getState().setOpen(false)
        setCanvasOpen(false)
        setLibraryOpen(false)
        setMemoryOpen(false)
        setPresetsOpen(false)
        setTrashOpen(false)
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
      libraryOpen,
      memoryOpen,
      openCanvasInspector,
      presetsOpen,
      trashOpen,
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
    if (generationOpen) {
      setGenerationOpen(false)
      return
    }
    if (memoryOpen) {
      setMemoryOpen(false)
      return
    }
    if (presetsOpen) {
      setPresetsOpen(false)
      return
    }
    if (trashOpen) {
      setTrashOpen(false)
      return
    }
    setLibraryOpen(false)
  }, [
    artifactController.state.isOpen,
    canvasOpen,
    closeArtifactPanel,
    generationOpen,
    memoryOpen,
    presetsOpen,
    trashOpen,
  ])

  const handleOpenPresets = useCallback(
    () => handleToggleInspector('presets'),
    [handleToggleInspector]
  )

  const handleOpenTrash = useCallback(
    () => handleToggleInspector('trash'),
    [handleToggleInspector]
  )

  // Restoring a trashed canvas remounts the canvas preview against the freshly
  // restored project; the trash panel already removed the row.
  const handleRestoreTrashedCanvas = useCallback(async (projectId: string) => {
    await restoreCanvasProject(projectId)
    setCanvasRefreshSignal((value) => value + 1)
  }, [])

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

  const clearPendingLibraryFiles = useCallback(() => {
    setPendingLibraryFiles([])
  }, [])

  const clearPendingLibraryText = useCallback(() => {
    setPendingLibraryText(null)
  }, [])

  // Library sends go through the composer, not a direct upload: the file joins
  // the normal pending attachments and is validated and uploaded on submit.
  const handleLibraryAttachmentToChat = useCallback(
    async (asset: PlaygroundAssetItem) => {
      try {
        const entry = await loadPlaygroundAttachment(
          playgroundAttachmentContentUrl(asset.sessionId, asset.id),
          asset.id
        )
        const blob = entry.blob
        if (!blob) return
        const file = new File([blob], asset.title || asset.id, {
          type: asset.mediaType || blob.type || 'application/octet-stream',
        })
        setPendingLibraryFiles((current) => [...current, file])
      } catch (error) {
        handleServerError(error, t('Unable to add the asset to your message.'))
      }
    },
    [t]
  )

  const handleLibraryArtifactToChat = useCallback(
    async (asset: PlaygroundAssetItem) => {
      try {
        const result = await getPlaygroundArtifact(asset.sessionId, asset.id)
        setPendingLibraryText(result.version.content)
      } catch (error) {
        handleServerError(error, t('Unable to add the asset to your message.'))
      }
    },
    [t]
  )

  const handleLibraryAssetToCanvas = useCallback(
    (asset: PlaygroundAssetItem) => {
      if (asset.kind === 'attachment') {
        setCanvasSendSeeds(
          buildAttachmentCanvasSeeds({
            sessionId: asset.sessionId,
            attachmentId: asset.id,
            filename: asset.title || undefined,
            mediaType: asset.mediaType,
          })
        )
        return
      }
      setCanvasSendSeeds(
        buildArtifactCanvasSeeds({
          sessionId: asset.sessionId,
          artifactId: asset.id,
          title: asset.title,
        })
      )
    },
    []
  )

  const handleLibraryOpenConversation = useCallback(
    (sessionId: string) => {
      const match = sessions.find((session) => session.server?.id === sessionId)
      if (!match) return
      if (match.id !== activeSessionId) handleSwitchSession(match.id)
    },
    [activeSessionId, handleSwitchSession, sessions]
  )

  const handleOpenMemorySource = useCallback(
    (sessionId: string) => {
      const match = sessions.find((session) => session.server?.id === sessionId)
      if (!match) {
        toast.error(t('The source conversation is no longer available.'))
        return
      }
      if (match.id !== activeSessionId) handleSwitchSession(match.id)
    },
    [activeSessionId, handleSwitchSession, sessions, t]
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
        onOpenPresets={handleOpenPresets}
        onOpenTrash={handleOpenTrash}
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
        inspectorView={inspectorView}
        artifactsDisabled={!canonicalSessionId}
        onToggleInspector={handleToggleInspector}
        onCloseInspector={handleCloseInspector}
        inspector={
          inspectorView === 'canvas' ? (
            <PlaygroundCanvasPanel
              activeProjectId={canvasProjectId}
              onOpenProject={handleOpenCanvasProject}
              refreshSignal={canvasRefreshSignal}
            />
          ) : inspectorView === 'generate' ? (
            <PlaygroundGenerationPanel
              active
              disabled={sync.isLoading}
              group={config.group}
              models={models}
              onSendToCanvas={(seeds) => setCanvasSendSeeds(seeds)}
            />
          ) : inspectorView === 'library' ? (
            <PlaygroundAssetLibrary
              active
              userId={userId}
              onOpenConversation={handleLibraryOpenConversation}
              onSendAttachmentToChat={handleLibraryAttachmentToChat}
              onSendArtifactToChat={handleLibraryArtifactToChat}
              onSendSeedsToCanvas={(seeds) => setCanvasSendSeeds(seeds)}
              onSendToCanvas={handleLibraryAssetToCanvas}
            />
          ) : inspectorView === 'presets' ? (
            <PlaygroundPresetPanel
              active
              currentConfig={config}
              currentParameterEnabled={parameterEnabled}
              currentSystemPrompt={systemPrompt}
              disabled={sync.isLoading}
              models={models}
              onApplyPreset={handleApplyPreset}
              onCreateSession={handleCreateSessionWithPreset}
            />
          ) : inspectorView === 'memory' ? (
            <PlaygroundMemoryPanel
              active
              disabled={sync.isLoading}
              extraction={memoryExtraction}
              models={models}
              onExtractionChange={handleMemoryExtractionChange}
              onOpenSourceSession={handleOpenMemorySource}
              userId={userId}
            />
          ) : inspectorView === 'trash' ? (
            <PlaygroundTrashPanel
              onRestoreCanvas={handleRestoreTrashedCanvas}
              onRestoreSession={restoreSession}
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
          <PlaygroundSessionUsage
            className='shrink-0 pt-0'
            costs={messageCosts}
            messages={messages}
          />
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            <PlaygroundChat
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
              isGenerating={isGenerating || isComparing}
              editingKey={editingMessageKey}
              onCancelEdit={handleEditOpenChange}
              onSaveEdit={(newContent) => applyEdit(newContent, false)}
              onSaveEditAndSubmit={(newContent) => applyEdit(newContent, true)}
              contextSummary={contextSummary}
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
              pendingFiles={pendingLibraryFiles}
              onPendingFilesConsumed={clearPendingLibraryFiles}
              pendingText={pendingLibraryText}
              onPendingTextConsumed={clearPendingLibraryText}
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
