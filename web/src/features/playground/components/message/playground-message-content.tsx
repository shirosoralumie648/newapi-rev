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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  CodeBlock,
  CodeBlockCopyButton,
} from '@/components/ai-elements/code-block'
import { Loader } from '@/components/ai-elements/loader'
import { MessageContent } from '@/components/ai-elements/message'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import { Response } from '@/components/ai-elements/response'
import { Shimmer } from '@/components/ai-elements/shimmer'
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '@/components/ai-elements/sources'
import { cn } from '@/lib/utils'

import { MESSAGE_STATUS } from '../../constants'
import {
  getMessageAlignmentClass,
  getMessageContentState,
  isErrorMessage,
  type MessageAlignment,
} from '../../lib'
import { getMessageContentStyles } from '../../lib/message/message-styles'
import type {
  Message,
  MessageVersion,
  PlaygroundMessageCost,
} from '../../types'
import { MessageAttachmentList } from './message-attachment-list'
import { MessageError } from './message-error'
import { MessageMetadata } from './message-metadata'
import { MessageToolCalls } from './message-tool-calls'

type PlaygroundMessageContentProps = {
  actions: ReactNode
  alignment: MessageAlignment
  /** Settled consume row of this version's request, when it is loaded. */
  cost?: PlaygroundMessageCost
  errorActions?: ReactNode
  isGenerating?: boolean
  isLastMessage?: boolean
  isSourceVisible?: boolean
  message: Message
  onContinueToolCalls?: (message: Message) => void
  onDenyToolCall?: (message: Message, toolCallId: string) => void
  onProvideToolResult?: (
    message: Message,
    toolCallId: string,
    result: string
  ) => void
  version: MessageVersion
}

export function PlaygroundMessageContent({
  actions,
  alignment,
  cost,
  errorActions,
  isGenerating = false,
  isLastMessage = false,
  isSourceVisible = false,
  message,
  onContinueToolCalls,
  onDenyToolCall,
  onProvideToolResult,
  version,
}: PlaygroundMessageContentProps) {
  const { t } = useTranslation()
  const versionContent = version.content
  const {
    displayContent,
    hasReasoning,
    hasSources,
    reasoningContent,
    showLoader,
    showMessageContent,
    sources,
  } = getMessageContentState(message, versionContent, version)
  const isError = isErrorMessage(message)
  const isMessageFinal =
    message.status !== MESSAGE_STATUS.LOADING &&
    message.status !== MESSAGE_STATUS.STREAMING
  const hasAttachments = (version.attachments?.length ?? 0) > 0
  const hasVisibleContent = versionContent.length > 0 || hasAttachments

  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col',
        getMessageAlignmentClass(alignment)
      )}
    >
      {hasSources && (
        <Sources>
          <SourcesTrigger count={sources.length} />
          <SourcesContent>
            {sources.map((source) => (
              <Source
                href={source.href}
                key={`${source.href}-${source.title}`}
                title={source.title}
              />
            ))}
          </SourcesContent>
        </Sources>
      )}

      {hasReasoning && (
        <Reasoning
          defaultOpen
          duration={message.reasoning?.duration}
          isStreaming={message.isReasoningStreaming}
        >
          <ReasoningTrigger />
          <ReasoningContent>{reasoningContent}</ReasoningContent>
        </Reasoning>
      )}

      {showLoader && (
        <div className='flex items-center gap-2 py-2'>
          <Loader />
          <Shimmer className='text-sm' duration={1}>
            {t('Responding...')}
          </Shimmer>
        </div>
      )}

      {isError && (
        <>
          <MessageError message={message} className='mb-2' />
          <MessageMetadata
            alignment={alignment}
            cost={cost}
            message={message}
            version={version}
          />
          {errorActions}
        </>
      )}

      {!isError && showMessageContent && (
        <>
          {hasVisibleContent && (
            <>
              <MessageAttachmentList attachments={version.attachments ?? []} />
              {isSourceVisible ? (
                <CodeBlock
                  code={versionContent}
                  className='my-0 group-[.is-assistant]:w-full group-[.is-assistant]:max-w-[78ch]'
                  collapsedLines={24}
                  defaultCollapsed={false}
                  language='markdown'
                  maxExpandedLines={48}
                  showLineNumbers
                  showToolbar
                  title={t('Raw response')}
                >
                  <CodeBlockCopyButton />
                </CodeBlock>
              ) : (
                <MessageContent
                  variant='flat'
                  className={cn(getMessageContentStyles())}
                >
                  <Response final={isMessageFinal}>{displayContent}</Response>
                </MessageContent>
              )}
            </>
          )}
          <MessageToolCalls
            isGenerating={isGenerating}
            isLastMessage={isLastMessage}
            message={message}
            onContinue={onContinueToolCalls}
            onDeny={onDenyToolCall}
            onProvideResult={onProvideToolResult}
            version={version}
          />
          <MessageMetadata
            alignment={alignment}
            cost={cost}
            message={message}
            version={version}
          />
          {actions}
        </>
      )}
    </div>
  )
}
