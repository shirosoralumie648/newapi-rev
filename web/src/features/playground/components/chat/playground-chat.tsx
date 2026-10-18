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

import {
  Branch,
  BranchMessages,
  BranchNext,
  BranchPage,
  BranchPrevious,
  BranchSelector,
} from '@/components/ai-elements/branch'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Loader } from '@/components/ai-elements/loader'
import { Message } from '@/components/ai-elements/message'

import {
  getActiveVersionIndex,
  getChatMessageRenderState,
  getEditingMessageContent,
  getMessageAlignment,
  getPreviousUserMessage,
  isErrorMessage,
  isParallelMessage,
} from '../../lib'
import type {
  Message as MessageType,
  PlaygroundContextSummary,
  PlaygroundMessageCost,
  PlaygroundMessageLayoutMode,
} from '../../types'
import { MessageActions } from '../message/message-actions'
import { MessageErrorActions } from '../message/message-error-actions'
import { PlaygroundMessageContent } from '../message/playground-message-content'
import { PlaygroundMessageEditor } from '../message/playground-message-editor'
import { PlaygroundContextNode } from './playground-context-node'
import { PlaygroundEmptyState } from './playground-empty-state'
import { PlaygroundParallelCompare } from './playground-parallel-compare'

const MAX_RENDERED_HISTORY_MESSAGES = 24

interface PlaygroundChatProps {
  messages: MessageType[]
  /** Settled cost rows of the conversation's relay requests, by request id. */
  costs?: ReadonlyMap<string, PlaygroundMessageCost>
  onCopyMessage?: (message: MessageType) => void
  onReadAloud?: (message: MessageType) => void
  onRegenerateMessage?: (message: MessageType) => void
  onEditMessage?: (message: MessageType) => void
  onDeleteMessage?: (message: MessageType) => void
  onSelectVersion?: (message: MessageType, versionIndex: number) => void
  onCreateArtifact?: (message: MessageType) => void
  onSendToCanvas?: (message: MessageType) => void
  onSelectPrompt?: (prompt: string) => void
  onProvideToolResult?: (
    message: MessageType,
    toolCallId: string,
    result: string
  ) => void
  onDenyToolCall?: (message: MessageType, toolCallId: string) => void
  onContinueToolCalls?: (message: MessageType) => void
  /** Retry one failed model of a parallel comparison message. */
  onRetryParallelVersion?: (message: MessageType, versionIndex: number) => void
  isGenerating?: boolean
  isLoadingMessages?: boolean
  editingKey?: string | null
  onSaveEdit?: (newContent: string) => void
  onCancelEdit?: (open: boolean) => void
  onSaveEditAndSubmit?: (newContent: string) => void
  messageLayoutMode?: PlaygroundMessageLayoutMode
  /** Compression node that replaces older messages in the next request. */
  contextSummary?: PlaygroundContextSummary | null
  /** Undo the compression: the stored messages stay, the node is removed. */
  onRemoveContextSummary?: () => void
}

export function PlaygroundChat({
  messages,
  costs,
  onCopyMessage,
  onReadAloud,
  onRegenerateMessage,
  onEditMessage,
  onDeleteMessage,
  onSelectVersion,
  onCreateArtifact,
  onSendToCanvas,
  onSelectPrompt,
  onProvideToolResult,
  onDenyToolCall,
  onContinueToolCalls,
  onRetryParallelVersion,
  isGenerating = false,
  isLoadingMessages = false,
  editingKey,
  onSaveEdit,
  onCancelEdit,
  onSaveEditAndSubmit,
  messageLayoutMode = 'alternating',
  contextSummary,
  onRemoveContextSummary,
}: PlaygroundChatProps) {
  const { t } = useTranslation()
  const [editText, setEditText] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [sourceMessageKeys, setSourceMessageKeys] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const visibleMessageOffset = Math.max(
    0,
    messages.length - MAX_RENDERED_HISTORY_MESSAGES
  )
  const visibleMessages = messages.slice(visibleMessageOffset)

  function handleToggleMessageSource(message: MessageType): void {
    setSourceMessageKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys)

      if (nextKeys.has(message.key)) {
        nextKeys.delete(message.key)
      } else {
        nextKeys.add(message.key)
      }

      return nextKeys
    })
  }

  useEffect(() => {
    if (!editingKey) return
    const content = getEditingMessageContent(messages, editingKey)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditText(content)

    setOriginalText(content)
  }, [editingKey, messages])

  let chatContent = visibleMessages.map((message, visibleMessageIndex) => {
    const messageIndex = visibleMessageOffset + visibleMessageIndex
    const { alwaysShowActions, isEditing } = getChatMessageRenderState(
      messages,
      message,
      messageIndex,
      editingKey
    )
    const isError = isErrorMessage(message)
    const previousUserMessage = isError
      ? getPreviousUserMessage(messages, messageIndex)
      : null
    const alignment = getMessageAlignment(message, messageLayoutMode)
    const isSourceVisible = sourceMessageKeys.has(message.key)
    const isLastMessage = messageIndex === messages.length - 1
    const messageActions = (
      <MessageActions
        message={message}
        onCopy={onCopyMessage}
        onReadAloud={onReadAloud}
        onRegenerate={onRegenerateMessage}
        onToggleSource={handleToggleMessageSource}
        onEdit={onEditMessage}
        onDelete={onDeleteMessage}
        onCreateArtifact={onCreateArtifact}
        onSendToCanvas={onSendToCanvas}
        isSourceVisible={isSourceVisible}
        isGenerating={isGenerating}
        alwaysVisible={alwaysShowActions}
        className='mt-1.5'
      />
    )
    const errorActions = isError ? (
      <MessageErrorActions
        disabled={isGenerating}
        onRetry={
          onRegenerateMessage ? () => onRegenerateMessage(message) : undefined
        }
        onEditPrompt={
          onEditMessage && previousUserMessage
            ? () => onEditMessage(previousUserMessage)
            : undefined
        }
        onDelete={onDeleteMessage ? () => onDeleteMessage(message) : undefined}
      />
    ) : undefined

    // A comparison group answers with its own side-by-side view; every other
    // reply keeps the ordinary branch renderer.
    const answerView = isParallelMessage(message) ? (
      <PlaygroundParallelCompare
        costs={costs}
        isGenerating={isGenerating}
        isLastMessage={isLastMessage}
        message={message}
        onContinueToolCalls={onContinueToolCalls}
        onDenyToolCall={onDenyToolCall}
        onProvideToolResult={onProvideToolResult}
        onRetryVersion={onRetryParallelVersion}
        onSelectVersion={onSelectVersion}
      />
    ) : (
      <Branch
        defaultBranch={getActiveVersionIndex(message)}
        key={`${message.key}:${message.versions.length}`}
        onBranchChange={(versionIndex) =>
          onSelectVersion?.(message, versionIndex)
        }
      >
        <BranchMessages>
          {message.versions.map((version, versionIndex) => (
            <PlaygroundMessageContent
              actions={messageActions}
              alignment={alignment}
              cost={
                version.requestId ? costs?.get(version.requestId) : undefined
              }
              errorActions={errorActions}
              isGenerating={isGenerating}
              isLastMessage={isLastMessage}
              isSourceVisible={isSourceVisible}
              key={`${version.id}-${versionIndex}`}
              message={message}
              onContinueToolCalls={onContinueToolCalls}
              onDenyToolCall={onDenyToolCall}
              onProvideToolResult={onProvideToolResult}
              version={version}
            />
          ))}
        </BranchMessages>
        <BranchSelector from={message.from}>
          <BranchPrevious disabled={isGenerating} />
          <BranchPage />
          <BranchNext disabled={isGenerating} />
        </BranchSelector>
      </Branch>
    )

    return (
      <Message
        className='group flex-row-reverse py-2.5'
        from={message.from}
        key={message.key}
      >
        <div className='w-full min-w-0 flex-1 basis-full'>
          {isEditing ? (
            <PlaygroundMessageEditor
              editText={editText}
              message={message}
              onCancelEdit={onCancelEdit}
              onEditTextChange={setEditText}
              onSaveEdit={onSaveEdit}
              onSaveEditAndSubmit={onSaveEditAndSubmit}
              originalText={originalText}
            />
          ) : (
            answerView
          )}
        </div>
      </Message>
    )
  })

  if (visibleMessages.length === 0 && onSelectPrompt) {
    chatContent = [
      <PlaygroundEmptyState key='empty' onSelectPrompt={onSelectPrompt} />,
    ]
  }

  // The compression node sits right after the last message it covers. When
  // that message is outside the rendered window the node still appears first,
  // so the conversation never looks like it silently lost history.
  const compressionKey = contextSummary?.throughMessageKey ?? ''
  const compressionIndex = compressionKey
    ? messages.findIndex((message) => message.key === compressionKey)
    : -1
  if (contextSummary && compressionIndex >= 0) {
    const insertIndex = Math.max(0, compressionIndex - visibleMessageOffset + 1)
    chatContent = [
      ...chatContent.slice(0, insertIndex),
      <PlaygroundContextNode
        disabled={isGenerating}
        key='playground-context-node'
        onRemove={onRemoveContextSummary}
        summary={contextSummary}
      />,
      ...chatContent.slice(insertIndex),
    ]
  }

  if (isLoadingMessages) {
    chatContent = [
      <div
        className='text-muted-foreground flex min-h-[min(520px,calc(100svh-18rem))] items-center justify-center gap-2 text-sm'
        key='loading'
      >
        <Loader />
        <span>{t('Loading conversation...')}</span>
      </div>,
    ]
  }

  return (
    <Conversation>
      {/* Remove outer padding; apply padding to inner centered container to align with input */}
      <ConversationContent className='p-0'>
        <div className='mx-auto w-full max-w-4xl px-4 py-4'>{chatContent}</div>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
