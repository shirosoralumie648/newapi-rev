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
import type { CanvasRouteSearch } from '@/features/canvas/lib/canvas-navigation'
import {
  buildMessageCanvasSeeds,
  type CanvasSendSeed,
} from '@/features/canvas/lib/canvas-send'
import { handleServerError } from '@/lib/handle-server-error'
import { ROLE } from '@/lib/roles'
import { getServerMessage } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getPlaygroundLogReplay, searchPlaygroundWeb } from './api'
import { PlaygroundArtifactSourceSheet } from './components/artifact/playground-artifact-source-sheet'
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundComparisonDialog } from './components/comparison/playground-comparison-dialog'
import { PlaygroundRequestViewer } from './components/developer/playground-request-viewer'
import { PlaygroundContextStatus } from './components/input/playground-context-status'
import { PlaygroundCostStatus } from './components/input/playground-cost-status'
import { PlaygroundInput } from './components/input/playground-input'
import { PlaygroundQuoteBar } from './components/input/playground-quote-bar'
import { PlaygroundSpeechDialog } from './components/message/playground-speech-dialog'
import { PlaygroundMemoryPanel } from './components/workspace/playground-memory-panel'
import { PlaygroundMessageSearch } from './components/workspace/playground-message-search'
import { PlaygroundPresetPanel } from './components/workspace/playground-preset-panel'
import { PlaygroundSessionUsage } from './components/workspace/playground-session-usage'
import { PlaygroundTrashPanel } from './components/workspace/playground-trash-panel'
import { PlaygroundUsageAnalyticsPanel } from './components/workspace/playground-usage-analytics'
import { PlaygroundUsagePopover } from './components/workspace/playground-usage-popover'
import {
  PlaygroundWorkspace,
  type PlaygroundInspectorView,
} from './components/workspace/playground-workspace'
import {
  DEFAULT_SESSION_TITLE,
  MESSAGE_ACTION_LABELS,
  PLAYGROUND_FORK_ERRORS,
  PLAYGROUND_IMPORT_ERRORS,
  PLAYGROUND_IMPORT_MAX_FILE_BYTES,
  PLAYGROUND_PARALLEL_MIN_MODELS,
  PLAYGROUND_SPEECH_ERRORS,
  PLAYGROUND_TOOL_CALL_RESULT_DEFAULT_MAX_BYTES,
} from './constants'
import {
  useAutoReadAloud,
  useAutoSessionTitle,
  useChatHandler,
  useKnowledgeBases,
  useParallelChat,
  usePlaygroundComparisonRunner,
  usePlaygroundContext,
  usePlaygroundConversation,
  usePlaygroundKnowledgeRetrieval,
  usePlaygroundMessageCosts,
  usePlaygroundMemories,
  usePlaygroundMemoryExtraction,
  usePlaygroundMCPCatalog,
  usePlaygroundOptions,
  usePlaygroundArena,
  usePlaygroundArtifacts,
  usePlaygroundPreferences,
  usePlaygroundSandboxSettings,
  usePlaygroundState,
  usePlaygroundServer,
  usePlaygroundToolExecution,
} from './hooks'
import type { CapturedArtifactSource } from './hooks/use-playground-artifacts'
import {
  appendParallelMessagePair,
  buildPlaygroundReplayDraft,
  collectMessageRequestIds,
  createPendingQuote,
  developerOptionsActive,
  estimatePlaygroundCost,
  forkPlaygroundSession,
  formatMemoryBlock,
  getCurrentVersion,
  getMessageContent,
  getMessageContentState,
  hasPendingToolCalls,
  importPlaygroundSessionDocument,
  loadMemoryExtractionSettings,
  parsePlaygroundSessionExport,
  PLAYGROUND_ATTACHMENT_ERRORS,
  presetSessionSettings,
  saveMemoryExtractionSettings,
  uploadPlaygroundAttachments,
  uploadPlaygroundSpeechAttachment,
} from './lib'
import {
  buildMCPToolDeclarations,
  buildMCPToolRefs,
  summarizeMCPServers,
} from './lib/tools/mcp-tools'
import type {
  AssistantPreset,
  Message,
  MessageAttachment,
  MessageSearchSnapshot,
  PlaygroundMemoryExtractionSettings,
  PlaygroundPendingQuote,
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
  const role = useAuthStore((state) => state.auth.user?.role ?? ROLE.USER)
  const isAdmin = role >= ROLE.ADMIN
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
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  // Inspector sheet of the last captured request payload. Opening it never
  // builds a request; it only shows what the last send already built.
  const [requestViewerOpen, setRequestViewerOpen] = useState(false)
  // Composer-level quote of an earlier message; it is consumed by the next
  // send and never stored with the conversation.
  const [pendingQuote, setPendingQuote] =
    useState<PlaygroundPendingQuote | null>(null)
  // Message a cross-session search or a deep link asked the reader to see.
  const [highlightedMessageKey, setHighlightedMessageKey] = useState<
    string | null
  >(null)
  const [messageSearchOpen, setMessageSearchOpen] = useState(false)
  const appliedSessionRef = useRef<string | null>(null)
  // A replay deep link is applied at most once per log reference.
  const appliedReplayRef = useRef<string | null>(null)
  // Composer text a replay link restored; consumed once by PlaygroundInput.
  const [replayPrefill, setReplayPrefill] = useState('')
  const [compareModels, setCompareModels] = useState<string[]>([])
  // The next two-model comparison hides model names and records one raw
  // preference per message group. It never computes a ranking.
  const [anonymousCompare, setAnonymousCompare] = useState(false)
  const [compareRunsOpen, setCompareRunsOpen] = useState(false)
  const comparisonRunner = usePlaygroundComparisonRunner()
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
    updateKnowledgeBaseIds,
    developerOptions,
    updateDeveloperOptions,
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

  const activeSession = sessions.find(
    (session) => session.id === activeSessionId
  )
  const knowledgeBaseIds = activeSession?.knowledgeBaseIds ?? []
  const {
    retrieve: retrieveKnowledge,
    diagnostics: knowledgeDiagnostics,
    isRetrieving: isRetrievingKnowledge,
  } = usePlaygroundKnowledgeRetrieval()
  const prepareKnowledge = useCallback(
    (nextMessages: Message[]) =>
      retrieveKnowledge(nextMessages, knowledgeBaseIds, config.group),
    [config.group, knowledgeBaseIds, retrieveKnowledge]
  )

  // Cross-session memory: every enabled note of the account is injected after
  // the system prompt, and extraction is opt-in per account.
  const memoriesQuery = usePlaygroundMemories(userId)
  // Knowledge bases the account may bind to the conversation. The list is
  // shared with the canvas knowledge manager through the query cache.
  const knowledgeBasesQuery = useKnowledgeBases(userId)
  const knowledgeBases = knowledgeBasesQuery.data ?? []
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

  // The administrator switch is authoritative: a deployment without a search
  // provider hides the control, and a query that has not answered yet stays
  // unavailable. The toggle itself only chooses whether this turn searches.
  const serverSettings = usePlaygroundSandboxSettings(userId)
  const webSearchAvailable = serverSettings.data?.webSearchEnabled === true
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)

  const preferences = usePlaygroundPreferences(userId)
  // MCP tools are declared to the model only while the administrator feature,
  // the account switch and the LB-09 tool loop are all on. The catalog is
  // requested only then, so a disabled feature never touches the connections;
  // the refs are the same set the loop may execute, resolved from the catalog
  // rather than from a model-produced name.
  const mcpActive =
    serverSettings.data?.mcpEnabled === true &&
    preferences.mcpEnabled &&
    preferences.toolExecutionEnabled
  const mcpCatalog = usePlaygroundMCPCatalog(userId, mcpActive)
  // The catalog stays cached after a switch turns off, so the refs are gated
  // on the active flag too: while any switch is off the request carries no MCP
  // declaration and no MCP call may execute.
  const mcpToolRefs = useMemo(
    () => (mcpActive ? buildMCPToolRefs(mcpCatalog.data) : []),
    [mcpActive, mcpCatalog.data]
  )
  const mcpToolDeclarations = useMemo(
    () => buildMCPToolDeclarations(mcpToolRefs),
    [mcpToolRefs]
  )
  const mcpServers = useMemo(
    () => summarizeMCPServers(mcpCatalog.data),
    [mcpCatalog.data]
  )
  const mcpControl = useMemo(
    () =>
      serverSettings.data?.mcpEnabled
        ? {
            enabled: preferences.mcpEnabled,
            failed: mcpCatalog.isError,
            loading: mcpCatalog.isLoading,
            onEnabledChange: preferences.setMCPEnabled,
            servers: mcpServers,
          }
        : undefined,
    [
      mcpCatalog.isError,
      mcpCatalog.isLoading,
      mcpServers,
      preferences.mcpEnabled,
      preferences.setMCPEnabled,
      serverSettings.data?.mcpEnabled,
    ]
  )
  // Automatic read-aloud runs after a reply completes. It is fire-and-forget:
  // the composer is never disabled and a late take from another conversation is
  // discarded by the hook's sequence guard.
  const autoRead = useAutoReadAloud({
    enabled: preferences.isAutoReadEnabled(activeSessionId),
    sessionId: activeSessionId,
    model: models[0]?.value ?? '',
    group: config.group,
  })

  const {
    capturedRequest,
    sendChat,
    continueChat,
    stopGeneration,
    isGenerating,
  } = useChatHandler({
    config,
    parameterEnabled,
    systemPrompt,
    memoryBlock,
    contextSettings: context,
    developerOptions,
    mcpTools: mcpToolDeclarations,
    prepareContextSummary: contextController.prepareForSend,
    prepareKnowledge,
    onMessageUpdate: updateMessages,
    onResponseComplete: (result) => autoRead.read(result.content),
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
    prepareKnowledge,
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
  // Automatic naming runs after a reply or comparison completes. It is silent,
  // only replaces the untouched default title and writes through the ordinary
  // rename/autosave chain.
  useAutoSessionTitle({
    enabled: preferences.isAutoTitleEnabled(activeSessionId),
    sessionId: activeSessionId,
    sessionTitle: activeSession?.title ?? DEFAULT_SESSION_TITLE,
    messages,
    model: context.summaryModel.trim() || config.model,
    group: config.group,
    isBusy: isGenerating || isComparing,
    onRename: renameSession,
  })
  const canonicalSessionId = activeSession?.server?.id ?? null
  // A vote may be the first write of a still-local conversation, so bind the
  // server session through the ordinary save path before storing it.
  const ensureArenaSession = useCallback(async () => {
    if (!activeSessionId) return null
    const bound = await sync.ensureServerSession(activeSessionId)
    return bound.server?.id ?? null
  }, [activeSessionId, sync.ensureServerSession])
  const arena = usePlaygroundArena(
    userId,
    canonicalSessionId,
    isAdmin,
    ensureArenaSession
  )
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
    handleContinueMessage,
  } = usePlaygroundConversation({
    messages,
    updateMessages,
    sendChat,
    continueChat,
  })

  // The tool loop answers supported calls of the latest settled reply and
  // continues through the existing continuation chain. It writes only through
  // the snapshot contract, so the server sees ordinary completed calls.
  const toolExecution = usePlaygroundToolExecution({
    enabled: preferences.toolExecutionEnabled,
    group: config.group,
    isBusy: isGenerating || isComparing,
    knowledgeBaseIds,
    maxRounds: preferences.toolExecutionMaxRounds,
    mcpTools: mcpToolRefs,
    messages,
    onContinue: handleContinueToolCalls,
    onUpdateMessages: updateMessages,
    resultMaxBytes:
      serverSettings.data?.toolCallResultMaxBytes ??
      PLAYGROUND_TOOL_CALL_RESULT_DEFAULT_MAX_BYTES,
    sessionId: activeSessionId,
  })

  const pendingToolCalls = hasPendingToolCalls(messages)

  // One provider call per submitted turn. The server holds the price on the
  // wallet and settles it only after the provider answers, so a failed search
  // throws here and the composer keeps the message unsent.
  const runWebSearch = useCallback(
    async (text: string): Promise<MessageSearchSnapshot | undefined> => {
      if (!webSearchEnabled || !webSearchAvailable || !text.trim()) {
        return undefined
      }
      try {
        const response = await searchPlaygroundWeb(text)
        if (response.results.length === 0) {
          toast.info(t('No web search results were found for this turn.'))
        }
        return {
          query: response.query,
          ...(response.provider ? { provider: response.provider } : {}),
          results: response.results,
        }
      } catch (error) {
        handleServerError(
          error,
          t('Web search failed. The message was not sent.')
        )
        throw error
      }
    },
    [t, webSearchAvailable, webSearchEnabled]
  )

  // The composer sends an ordinary reply unless the compare selection holds a
  // comparison; with one, the same turn goes to every selected model as its
  // own request and lands as a comparison group. The pending quote is consumed
  // by this send and cleared so it never rides along with a later turn.
  const submitTurn = useCallback(
    (
      text: string,
      attachments?: MessageAttachment[],
      search?: MessageSearchSnapshot
    ) => {
      const quote = pendingQuote
      if (quote) setPendingQuote(null)
      if (anonymousCompare && compareModels.length !== 2) {
        // The arena is exactly A/B. Sending a larger or smaller group would
        // either reveal the comparison or silently drop the anonymous mode.
        toast.warning(t('Select exactly two models for the anonymous arena.'))
        return
      }
      if (compareModels.length < PLAYGROUND_PARALLEL_MIN_MODELS) {
        handleSendMessage(text, attachments, search, quote)
        return
      }
      const nextMessages = appendParallelMessagePair(
        messagesRef.current,
        text,
        attachments,
        compareModels,
        Date.now(),
        search,
        anonymousCompare
      )
      updateMessages(nextMessages)
      sendParallelChat(nextMessages, quote)
    },
    [
      anonymousCompare,
      compareModels,
      handleSendMessage,
      pendingQuote,
      sendParallelChat,
      t,
      updateMessages,
    ]
  )

  const handleInputSubmit = useCallback(
    async (text: string, files: (FileUIPart & { id?: string })[] = []) => {
      let attachments: MessageAttachment[] | undefined
      if (files.length > 0) {
        const session = activeSession
        if (!session) {
          throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UPLOAD_FAILED)
        }
        try {
          const bound = await sync.ensureServerSession(session.id)
          if (!bound.server) {
            throw new Error(PLAYGROUND_ATTACHMENT_ERRORS.UPLOAD_FAILED)
          }
          attachments = await uploadPlaygroundAttachments(
            bound.server.id,
            files
          )
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
      }
      // Attachments are uploaded first: a search failure then leaves the
      // message and its files in the composer instead of charging for a turn
      // the user never sent.
      const search = await runWebSearch(text)
      submitTurn(text, attachments, search)
    },
    [activeSession, runWebSearch, submitTurn, sync, t]
  )

  const handleSelectPrompt = useCallback(
    (prompt: string) => {
      // Starter questions are ordinary turns: they honor the search toggle and
      // surface a failed search exactly like the composer.
      void handleInputSubmit(prompt).catch(() => undefined)
    },
    [handleInputSubmit]
  )

  const handleStop = useCallback(() => {
    toolExecution.cancel()
    if (isComparing) stopComparison()
    if (isGenerating) stopGeneration()
  }, [
    isComparing,
    isGenerating,
    stopComparison,
    stopGeneration,
    toolExecution.cancel,
  ])

  const stopBeforeSessionChange = useCallback(() => {
    toolExecution.cancel()
    if (isComparing) stopComparison()
    if (isGenerating) stopGeneration()
  }, [
    isComparing,
    isGenerating,
    stopComparison,
    stopGeneration,
    toolExecution.cancel,
  ])

  const handleWorkspaceTransition = useCallback(
    <Result,>(action: () => Result): Result | undefined => {
      if (artifactController.state.dirty) {
        artifactController.store.getState().requestDiscard(action)
        return undefined
      }
      return action()
    },
    [artifactController.state.dirty, artifactController.store]
  )

  // Rebuild one exported conversation: the parser validates the JSON, the
  // import helper recreates the session and every message through the ordinary
  // create/upload chain (so quotas apply), and the workspace adopts the result.
  // Attachments from another account are unreachable and stay placeholders.
  const performImportConversation = useCallback(
    async (file: File) => {
      if (file.size > PLAYGROUND_IMPORT_MAX_FILE_BYTES) {
        toast.error(t(PLAYGROUND_IMPORT_ERRORS.TOO_LARGE))
        return
      }
      let document: ReturnType<typeof parsePlaygroundSessionExport>
      try {
        document = parsePlaygroundSessionExport(JSON.parse(await file.text()))
      } catch {
        toast.error(t(PLAYGROUND_IMPORT_ERRORS.INVALID_FILE))
        return
      }

      try {
        const result = await importPlaygroundSessionDocument(document)
        stopBeforeSessionChange()
        handleEditOpenChange(false)
        setArtifactSource(null)
        setSpeechSource(null)
        setPendingQuote(null)
        setHighlightedMessageKey(null)
        sync.adoptImportedSession(result.session)
        toast.success(t('Conversation imported'))
        if (result.unavailableAttachments > 0) {
          toast.info(
            t(
              '{{count}} attachments could not be restored and were kept as placeholders.',
              { count: result.unavailableAttachments }
            )
          )
        }
      } catch (error) {
        handleServerError(error, t(PLAYGROUND_IMPORT_ERRORS.FAILED))
      }
    },
    [handleEditOpenChange, stopBeforeSessionChange, sync, t]
  )

  // Importing activates a new conversation, so an unsaved artifact draft must
  // be confirmed before any server-side import starts (no orphan copy when the
  // user keeps the draft). The immediate path returns the import promise so the
  // session-list button keeps its busy state until the rebuild finishes.
  const handleImportConversation = useCallback(
    (file: File) =>
      handleWorkspaceTransition(() => performImportConversation(file)),
    [handleWorkspaceTransition, performImportConversation]
  )

  // The settings a preset contributes to a conversation: its model, sampling
  // parameters, parameter flags and system prompt. Routing and transport stay
  // with the conversation the user configured.
  const sessionSettingsFromPreset = useCallback(
    (preset: AssistantPreset) =>
      presetSessionSettings(preset, { config, parameterEnabled }),
    [config, parameterEnabled]
  )

  const modelDefaultsFor = useCallback(
    (modelValue: string) =>
      models.find((model) => model.value === modelValue)?.catalogDefaults,
    [models]
  )

  const handleCreateSession = useCallback(() => {
    if (sync.isLoading) return
    handleWorkspaceTransition(() => {
      stopBeforeSessionChange()
      handleEditOpenChange(false)
      setArtifactSource(null)
      setSpeechSource(null)
      setPendingQuote(null)
      setHighlightedMessageKey(null)
      createSession({
        model: config.model,
        modelDefaults: modelDefaultsFor(config.model),
      })
    })
  }, [
    config.model,
    createSession,
    modelDefaultsFor,
    sync.isLoading,
    stopBeforeSessionChange,
    handleEditOpenChange,
    handleWorkspaceTransition,
  ])

  // Starts a fresh conversation directly with a model picked in the selector.
  // Only the new conversation receives the catalog defaults; the previous one
  // and later model switches keep their own values.
  const handleCreateSessionWithModel = useCallback(
    (modelValue: string) => {
      if (sync.isLoading) return
      handleWorkspaceTransition(() => {
        stopBeforeSessionChange()
        handleEditOpenChange(false)
        setArtifactSource(null)
        setSpeechSource(null)
        setPendingQuote(null)
        setHighlightedMessageKey(null)
        createSession({
          model: modelValue,
          modelDefaults: modelDefaultsFor(modelValue),
        })
      })
    },
    [
      createSession,
      modelDefaultsFor,
      sync.isLoading,
      stopBeforeSessionChange,
      handleEditOpenChange,
      handleWorkspaceTransition,
    ]
  )

  const handleCreateSessionWithPreset = useCallback(
    (preset: AssistantPreset) => {
      if (sync.isLoading) return
      handleWorkspaceTransition(() => {
        stopBeforeSessionChange()
        handleEditOpenChange(false)
        setArtifactSource(null)
        setPendingQuote(null)
        setHighlightedMessageKey(null)
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
        // The composer quote and the highlight belong to the conversation the
        // user is leaving; the search flow re-sets the highlight right after
        // this switch in the same update.
        setPendingQuote(null)
        setHighlightedMessageKey(null)
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
          setPendingQuote(null)
          setHighlightedMessageKey(null)
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

  // Quoting only arms the composer: the snapshot is shown in the quote bar and
  // travels with the next request. A message without visible text cannot be
  // quoted.
  const handleQuoteMessage = useCallback(
    (message: Message) => {
      const quote = createPendingQuote(message)
      if (!quote) {
        toast.warning(t(MESSAGE_ACTION_LABELS.NO_CONTENT))
        return
      }
      setPendingQuote(quote)
    },
    [t]
  )

  // Forking rebuilds every message up to the chosen one as a new conversation
  // through the ordinary create/upload chain (so quotas apply and a refusal
  // leaves the source untouched), then adopts the copy.
  const performForkMessage = useCallback(
    async (message: Message) => {
      const session = activeSession
      if (!session) return
      try {
        const bound = await sync.ensureServerSession(session.id)
        if (!bound.server) {
          throw new Error(PLAYGROUND_FORK_ERRORS.FAILED)
        }
        const result = await forkPlaygroundSession({
          sourceSession: bound,
          messageKey: message.key,
          title: t('Fork of {{title}}', { title: session.title }),
        })
        stopBeforeSessionChange()
        handleEditOpenChange(false)
        setArtifactSource(null)
        setSpeechSource(null)
        setPendingQuote(null)
        setHighlightedMessageKey(null)
        sync.adoptImportedSession(result.session)
        toast.success(t('Conversation forked'))
        if (result.unavailableAttachments > 0) {
          toast.info(
            t(
              '{{count}} attachments could not be restored and were kept as placeholders.',
              { count: result.unavailableAttachments }
            )
          )
        }
      } catch (error) {
        handleServerError(error, t(PLAYGROUND_FORK_ERRORS.FAILED))
      }
    },
    [activeSession, handleEditOpenChange, stopBeforeSessionChange, sync, t]
  )

  const handleForkMessage = useCallback(
    (message: Message) => {
      if (sync.isLoading) return
      handleWorkspaceTransition(() => performForkMessage(message))
    },
    [handleWorkspaceTransition, performForkMessage, sync.isLoading]
  )

  // A search hit switches to its conversation (which clears the previous
  // highlight) and marks the message the chat then scrolls into view.
  const handleSelectSearchHit = useCallback(
    (sessionId: string, messageKey: string) => {
      if (sessionId !== activeSessionId) {
        if (sync.isLoading) return
        handleSwitchSession(sessionId)
      }
      setHighlightedMessageKey(messageKey)
    },
    [activeSessionId, handleSwitchSession, sync.isLoading]
  )

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
      const search: CanvasRouteSearch = {
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
  if (memoryOpen) inspectorView = 'memory'
  else if (presetsOpen) inspectorView = 'presets'
  else if (trashOpen) inspectorView = 'trash'
  else if (usageOpen) inspectorView = 'usage'

  const handleToggleInspector = useCallback((view: PlaygroundInspectorView) => {
    if (view === 'presets') {
      setMemoryOpen(false)
      setTrashOpen(false)
      setUsageOpen(false)
      setPresetsOpen((current) => !current)
      return
    }
    if (view === 'memory') {
      setPresetsOpen(false)
      setTrashOpen(false)
      setUsageOpen(false)
      setMemoryOpen((current) => !current)
      return
    }
    if (view === 'usage') {
      setPresetsOpen(false)
      setMemoryOpen(false)
      setTrashOpen(false)
      setUsageOpen((current) => !current)
      return
    }
    setPresetsOpen(false)
    setMemoryOpen(false)
    setUsageOpen(false)
    setTrashOpen((current) => !current)
  }, [])

  const handleCloseInspector = useCallback(() => {
    setPresetsOpen(false)
    setTrashOpen(false)
    setMemoryOpen(false)
    setUsageOpen(false)
  }, [])

  const handleOpenPresets = useCallback(
    () => handleToggleInspector('presets'),
    [handleToggleInspector]
  )

  const handleOpenTrash = useCallback(
    () => handleToggleInspector('trash'),
    [handleToggleInspector]
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

  // A /playground?replay=<request_id> deep link reopens a settled usage log as
  // a new draft: the parameters the log (or its retained summary) recorded are
  // applied to a fresh conversation and the last user turn is prefilled.
  // Nothing is sent automatically, and content the deployment did not retain is
  // reported instead of silently omitted.
  const requestedReplay = props.target?.replay
  const requestedReplayUser = props.target?.replayUser
  useEffect(() => {
    if (!requestedReplay || sync.isLoading) return
    const appliedKey = `${requestedReplay}:${requestedReplayUser ?? ''}`
    if (appliedReplayRef.current === appliedKey) return
    appliedReplayRef.current = appliedKey
    void getPlaygroundLogReplay(requestedReplay, requestedReplayUser)
      .then((replay) => {
        const draft = buildPlaygroundReplayDraft(replay)
        createSession({
          config: draft.config,
          parameterEnabled: draft.parameterEnabled,
        })
        if (draft.text) setReplayPrefill(draft.text)
        if (draft.contentNotice) toast.info(t(draft.contentNotice))
      })
      .catch((error) => {
        // A failed load must stay retryable: the same link may be clicked
        // again after a transient error.
        appliedReplayRef.current = null
        toast.error(
          getServerMessage(error) ?? t('Failed to load this log for replay.')
        )
      })
  }, [createSession, requestedReplay, requestedReplayUser, sync.isLoading, t])

  const handleReplayPrefillConsumed = useCallback(() => {
    setReplayPrefill('')
  }, [])

  // An old /playground?session=...&message=... link names the exact message it
  // points at; the chat renders and highlights it once hydration is complete.
  const requestedMessage = props.target?.message
  useEffect(() => {
    if (!requestedMessage || sync.isLoading) return
    setHighlightedMessageKey(requestedMessage)
  }, [requestedMessage, sync.isLoading])

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

  // Read-only send estimate: it mirrors the model's pricing but never reserves
  // quota; the consumption log carries the settled amount.
  const activeModel = models.find((model) => model.value === config.model)
  const costEstimate = estimatePlaygroundCost({
    model: activeModel,
    promptTokens: contextController.plan.estimatedTokens,
    completionTokens: parameterEnabled.max_tokens ? config.max_tokens : 0,
    groupRatio: groups.find((group) => group.value === config.group)?.ratio,
    contextLength: activeModel?.contextLength,
  })

  return (
    <>
      <PlaygroundWorkspace
        activeSessionId={activeSessionId}
        onCreate={handleCreateSession}
        onDelete={handleDeleteSession}
        onImportFile={handleImportConversation}
        onOpenMessageSearch={() => setMessageSearchOpen(true)}
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
        onToggleInspector={handleToggleInspector}
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
          ) : inspectorView === 'usage' ? (
            <PlaygroundUsageAnalyticsPanel active userId={userId} />
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
            costLoggingEnabled={messageCostQuery.data?.enabled}
            costs={messageCosts}
            messages={messages}
          />
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            <PlaygroundChat
              artifacts={artifactController.artifacts}
              messages={messages}
              costs={messageCosts}
              autoFilledToolCallKeys={toolExecution.autoFilledKeys}
              executingToolCallKeys={toolExecution.executingKeys}
              isLoadingMessages={isLoadingMessages || sync.isLoading}
              onRegenerateMessage={handleRegenerateMessage}
              onContinueMessage={handleContinueMessage}
              onQuoteMessage={handleQuoteMessage}
              onForkMessage={handleForkMessage}
              highlightedMessageKey={highlightedMessageKey}
              onReadAloud={activeSession ? handleReadAloud : undefined}
              onEditMessage={handleEditMessage}
              onDeleteMessage={handleDeleteMessage}
              onSelectVersion={handleSelectMessageVersion}
              onSelectPrompt={handleSelectPrompt}
              onProvideToolResult={handleProvideToolResult}
              onDenyToolCall={handleDenyToolCall}
              onContinueToolCalls={handleContinueToolCalls}
              onRetryParallelVersion={retryParallelVersion}
              arenaInstanceSummary={isAdmin ? arena.instanceSummary : undefined}
              arenaPersonalSummary={arena.personalSummary}
              arenaVotes={arena.votesByMessageKey}
              onArenaVote={arena.saveVote}
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
              responseFormat={
                developerOptionsActive(developerOptions)
                  ? developerOptions.responseFormat
                  : null
              }
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
            {pendingQuote ? (
              <PlaygroundQuoteBar
                className='mb-1'
                onRemove={() => setPendingQuote(null)}
                quote={pendingQuote}
              />
            ) : null}
            {toolExecution.isExecuting ? (
              <p
                role='status'
                className='text-muted-foreground px-1 pb-1 text-xs'
              >
                {t('Running tool calls automatically...')}
              </p>
            ) : pendingToolCalls ? (
              <p
                role='status'
                className='text-muted-foreground px-1 pb-1 text-xs'
              >
                {t('Answer or deny the requested tool calls to continue.')}
              </p>
            ) : null}
            {isRetrievingKnowledge && (
              <p
                role='status'
                className='text-muted-foreground px-1 pb-1 text-xs'
              >
                {t('Searching knowledge bases...')}
              </p>
            )}
            <PlaygroundContextStatus
              className='pb-1'
              isSummarizing={contextController.isSummarizing}
              plan={contextController.plan}
              settings={context}
            />
            <PlaygroundCostStatus className='pb-1' estimate={costEstimate} />
            <PlaygroundInput
              config={config}
              contextPlan={contextController.plan}
              contextSettings={context}
              contextSummary={contextSummary}
              developerOptions={developerOptions}
              sessionId={activeSession?.id}
              prefillText={replayPrefill || undefined}
              onPrefillTextConsumed={handleReplayPrefillConsumed}
              autoReadDefaultEnabled={preferences.autoReadDefault}
              autoReadEnabled={preferences.isAutoReadEnabled(activeSessionId)}
              autoReadHasOverride={preferences.hasSessionAutoReadOverride(
                activeSessionId
              )}
              autoTitleDefaultEnabled={preferences.autoTitleDefault}
              autoTitleEnabled={preferences.isAutoTitleEnabled(activeSessionId)}
              autoTitleHasOverride={preferences.hasSessionAutoTitleOverride(
                activeSessionId
              )}
              onAutoReadChange={(value) =>
                preferences.setSessionAutoRead(activeSessionId, value)
              }
              onAutoReadDefaultChange={preferences.setAutoReadDefault}
              onAutoReadUseDefault={() =>
                preferences.setSessionAutoRead(activeSessionId, null)
              }
              onAutoTitleChange={(value) =>
                preferences.setSessionAutoTitle(activeSessionId, value)
              }
              onAutoTitleDefaultChange={preferences.setAutoTitleDefault}
              onAutoTitleUseDefault={() =>
                preferences.setSessionAutoTitle(activeSessionId, null)
              }
              disabled={
                isGenerating ||
                isComparing ||
                sync.isLoading ||
                pendingToolCalls ||
                contextController.isSummarizing
              }
              groups={groups}
              groupValue={config.group}
              isGenerating={
                isGenerating || isComparing || toolExecution.isExecuting
              }
              isModelLoading={isLoadingModels}
              isSummarizing={contextController.isSummarizing}
              knowledgeBaseIds={knowledgeBaseIds}
              knowledgeBases={knowledgeBases}
              knowledgeDiagnostics={knowledgeDiagnostics}
              knowledgeLoading={knowledgeBasesQuery.isLoading}
              mcp={mcpControl}
              modelValue={config.model}
              models={models}
              anonymousCompare={anonymousCompare}
              compareModels={compareModels}
              onAnonymousCompareChange={setAnonymousCompare}
              onCompareModelsChange={setCompareModels}
              onOpenCompareRuns={() => setCompareRunsOpen(true)}
              onContextSettingsChange={updateContextSettings}
              onDeveloperOptionsChange={updateDeveloperOptions}
              onKnowledgeBaseIdsChange={updateKnowledgeBaseIds}
              onGroupChange={(value) => updateConfig('group', value)}
              onConfigChange={updateConfig}
              onClearMessages={handleClearMessages}
              onModelChange={(value) => updateConfig('model', value)}
              onStartNewSession={handleCreateSessionWithModel}
              onParameterEnabledChange={updateParameterEnabled}
              onRemoveContextSummary={handleRemoveContextSummary}
              onStop={handleStop}
              onSubmit={handleInputSubmit}
              onSummarizeContext={handleSummarizeContext}
              onSystemPromptChange={updateSystemPrompt}
              onWebSearchChange={setWebSearchEnabled}
              onToolExecutionEnabledChange={preferences.setToolExecutionEnabled}
              onToolExecutionMaxRoundsChange={
                preferences.setToolExecutionMaxRounds
              }
              parameterEnabled={parameterEnabled}
              systemPrompt={systemPrompt}
              toolExecutionEnabled={preferences.toolExecutionEnabled}
              toolExecutionMaxRounds={preferences.toolExecutionMaxRounds}
              webSearchAvailable={webSearchAvailable}
              webSearchEnabled={webSearchEnabled}
              hasMessages={messages.length > 0}
              hasCapturedRequest={capturedRequest !== null}
              onOpenRequestViewer={() => setRequestViewerOpen(true)}
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
      <PlaygroundRequestViewer
        open={requestViewerOpen}
        onOpenChange={setRequestViewerOpen}
        request={capturedRequest}
      />
      <PlaygroundComparisonDialog
        group={config.group}
        initialModels={compareModels}
        models={models}
        onOpenChange={setCompareRunsOpen}
        open={compareRunsOpen}
        runner={comparisonRunner}
        userId={userId}
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
      <PlaygroundMessageSearch
        isHydrating={sync.isLoading}
        onOpenChange={setMessageSearchOpen}
        onSelect={handleSelectSearchHit}
        open={messageSearchOpen}
        sessions={sessions}
      />
    </>
  )
}
