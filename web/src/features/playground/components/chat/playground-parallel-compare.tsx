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
import { CheckIcon, RotateCcwIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Loader } from '@/components/ai-elements/loader'
import { Response } from '@/components/ai-elements/response'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { MESSAGE_STATUS } from '../../constants'
import {
  anonymizeParallelMessage,
  anonymousParallelModelLabel,
  getActiveVersionIndex,
  getMessageContentState,
  hasPendingParallelVersions,
  isAnonymousParallelMessage,
  isPendingParallelVersion,
  linkKnowledgeCitations,
} from '../../lib'
import type {
  Message,
  MessageKnowledgeSnapshot,
  MessageVersion,
  PlaygroundArenaVote,
  PlaygroundArenaVoteSummary,
  PlaygroundMessageCost,
} from '../../types'
import { MessageError } from '../message/message-error'
import { MessageKnowledgeSources } from '../message/message-knowledge-sources'
import { MessageMetadata } from '../message/message-metadata'
import { MessageToolCalls } from '../message/message-tool-calls'
import { PlaygroundArenaVoteBar } from './playground-arena-vote'

interface PlaygroundParallelCompareProps {
  /** The caller's stored raw preference for this anonymous group. */
  arenaVote?: PlaygroundArenaVote
  /** Read-only personal totals shown by the vote bar summary. */
  arenaPersonalSummary?: PlaygroundArenaVoteSummary
  /** Administrator-only instance totals shown by the summary. */
  arenaInstanceSummary?: PlaygroundArenaVoteSummary
  /** Save or change the raw preference of this anonymous group. */
  onArenaVote?: (
    messageKey: string,
    choice: PlaygroundArenaVote['choice'],
    note: string
  ) => Promise<void> | void
  /** Settled cost rows of the compared requests, by request id. */
  costs?: ReadonlyMap<string, PlaygroundMessageCost>
  /** Calls being answered by the automatic tool loop right now. */
  executingToolCallKeys?: ReadonlySet<string>
  /** Calls the automatic tool loop answered during this mount. */
  autoFilledToolCallKeys?: ReadonlySet<string>
  isGenerating?: boolean
  isLastMessage?: boolean
  /** Snapshot of the user turn the compared replies answer, when it retrieved. */
  knowledge?: MessageKnowledgeSnapshot | null
  message: Message
  onContinueToolCalls?: (message: Message) => void
  onDenyToolCall?: (message: Message, toolCallId: string) => void
  onProvideToolResult?: (
    message: Message,
    toolCallId: string,
    result: string
  ) => void
  /** Retry one failed model; the other replies of the group are kept. */
  onRetryVersion?: (message: Message, versionIndex: number) => void
  /** Pick the reply that continues the conversation. */
  onSelectVersion?: (message: Message, versionIndex: number) => void
}

interface ParallelVersionCardProps {
  /** Anonymous groups replace model names and redact reply text. */
  anonymous: boolean
  cost?: PlaygroundMessageCost
  /** Calls being answered by the automatic tool loop right now. */
  executingToolCallKeys?: ReadonlySet<string>
  /** Calls the automatic tool loop answered during this mount. */
  autoFilledToolCallKeys?: ReadonlySet<string>
  isActive: boolean
  isGenerating?: boolean
  isLastMessage?: boolean
  /** Snapshot of the user turn the compared replies answer, when it retrieved. */
  knowledge?: MessageKnowledgeSnapshot | null
  message: Message
  onContinueToolCalls?: (message: Message) => void
  onDenyToolCall?: (message: Message, toolCallId: string) => void
  onProvideToolResult?: (
    message: Message,
    toolCallId: string,
    result: string
  ) => void
  onRetryVersion?: (message: Message, versionIndex: number) => void
  onSelectVersion?: (message: Message, versionIndex: number) => void
  version: MessageVersion
  versionIndex: number
}

/**
 * One compared reply. Its lifecycle is the version's own status, so a settled
 * reply renders while the models that are still answering keep their loaders.
 * Tool calls stay read-only until the card is the chosen reply, because that
 * is the version the Playground sends answers for.
 */
function ParallelVersionCard(props: ParallelVersionCardProps) {
  const { t } = useTranslation()
  const isPending = isPendingParallelVersion(props.version)
  const isFailed = props.version.status === MESSAGE_STATUS.ERROR
  const displayMessage = props.anonymous
    ? anonymizeParallelMessage(props.message)
    : props.message
  const displayVersion =
    displayMessage.versions[props.versionIndex] ?? props.version
  const modelLabel = props.anonymous
    ? anonymousParallelModelLabel(props.versionIndex)
    : (props.version.model ?? '')
  const displayContent = getMessageContentState(
    displayMessage,
    displayVersion.content,
    displayVersion
  ).displayContent
  const knowledgeAnchorId = `${props.message.key}-${props.versionIndex}`
  const knowledgeResultCount = props.knowledge?.results.length ?? 0
  const replyContent =
    knowledgeResultCount > 0
      ? linkKnowledgeCitations(
          displayContent,
          knowledgeAnchorId,
          knowledgeResultCount
        )
      : displayContent
  const canSelect =
    !isPending && !isFailed && !props.isActive && Boolean(props.onSelectVersion)

  let replyBody: ReactNode = null
  if (isPending) {
    replyBody = (
      <div className='flex items-center gap-2 py-1'>
        <Loader />
        <Shimmer className='text-sm' duration={1}>
          {t('Responding...')}
        </Shimmer>
      </div>
    )
  } else if (isFailed) {
    replyBody = (
      <MessageError
        actions={
          props.onRetryVersion ? (
            <Button
              disabled={props.isGenerating}
              onClick={() =>
                props.onRetryVersion?.(props.message, props.versionIndex)
              }
              size='sm'
              type='button'
              variant='outline'
            >
              <RotateCcwIcon aria-hidden='true' className='size-3.5' />
              {t('Retry this reply')}
            </Button>
          ) : undefined
        }
        message={{
          ...displayMessage,
          status: MESSAGE_STATUS.ERROR,
          errorCode: displayVersion.errorCode ?? null,
          activeVersionIndex: props.versionIndex,
        }}
      />
    )
  } else if (replyContent) {
    replyBody = <Response final>{replyContent}</Response>
  }

  return (
    <section
      aria-label={t('Reply from {{model}}', {
        model: modelLabel,
      })}
      className={cn(
        'border-border/60 bg-muted/20 flex min-w-0 flex-col rounded-lg border',
        props.isActive && 'border-primary/50 ring-primary/20 ring-1'
      )}
    >
      <header className='border-border/60 flex items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='truncate text-sm font-medium'>{modelLabel}</span>
        {props.isActive && !isPending && !isFailed ? (
          <span className='text-primary flex shrink-0 items-center gap-1 text-xs font-medium'>
            <CheckIcon aria-hidden='true' className='size-3.5' />
            {t('In use')}
          </span>
        ) : null}
      </header>

      <div className='flex-1 px-3 py-2.5 text-sm'>
        {!isPending && !isFailed && props.knowledge && (
          <MessageKnowledgeSources
            anchorId={knowledgeAnchorId}
            knowledge={props.knowledge}
          />
        )}
        {replyBody}
      </div>

      <div className='px-3'>
        <MessageToolCalls
          autoFilledToolCallKeys={props.autoFilledToolCallKeys}
          executingToolCallKeys={props.executingToolCallKeys}
          isGenerating={props.isGenerating || !props.isActive}
          isLastMessage={props.isLastMessage === true && props.isActive}
          message={props.message}
          onContinue={props.isActive ? props.onContinueToolCalls : undefined}
          onDeny={props.isActive ? props.onDenyToolCall : undefined}
          onProvideResult={
            props.isActive ? props.onProvideToolResult : undefined
          }
          version={props.version}
        />
      </div>

      <footer className='flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5'>
        <MessageMetadata
          alignment='left'
          cost={props.cost}
          hideChannel={props.anonymous}
          message={displayMessage}
          version={displayVersion}
        />
        {canSelect ? (
          <Button
            onClick={() =>
              props.onSelectVersion?.(props.message, props.versionIndex)
            }
            size='sm'
            type='button'
            variant='outline'
          >
            {t('Use this reply')}
          </Button>
        ) : null}
      </footer>
    </section>
  )
}

/**
 * The message group one parallel comparison produced: every compared model
 * has its own card so the replies can be read side by side. The user selects
 * one reply, which becomes the version that continues the conversation. On
 * narrow screens the cards stack; from `md` up they share two columns.
 */
export function PlaygroundParallelCompare(
  props: PlaygroundParallelCompareProps
) {
  const { t } = useTranslation()
  const activeIndex = getActiveVersionIndex(props.message)
  const anonymous = isAnonymousParallelMessage(props.message)
  const hasSelectableReply = props.message.versions.some(
    (version) => version.status === MESSAGE_STATUS.COMPLETE
  )
  const comparisonLabel = anonymous
    ? t('Anonymous comparison')
    : t('Comparing {{count}} models', {
        count: props.message.versions.length,
      })

  return (
    <div
      aria-label={comparisonLabel}
      className='flex w-full min-w-0 flex-col gap-2'
      role='group'
    >
      <div className='text-muted-foreground flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-0.5 text-xs'>
        <span className='font-medium'>{comparisonLabel}</span>
        {hasSelectableReply ? (
          <span>{t('Select one reply to continue the conversation')}</span>
        ) : null}
      </div>

      <div className='grid min-w-0 gap-2 md:grid-cols-2'>
        {props.message.versions.map((version, versionIndex) => (
          <ParallelVersionCard
            anonymous={anonymous}
            autoFilledToolCallKeys={props.autoFilledToolCallKeys}
            cost={
              version.requestId
                ? props.costs?.get(version.requestId)
                : undefined
            }
            executingToolCallKeys={props.executingToolCallKeys}
            isActive={versionIndex === activeIndex}
            isGenerating={props.isGenerating}
            isLastMessage={props.isLastMessage}
            key={version.id}
            knowledge={props.knowledge}
            message={props.message}
            onContinueToolCalls={props.onContinueToolCalls}
            onDenyToolCall={props.onDenyToolCall}
            onProvideToolResult={props.onProvideToolResult}
            onRetryVersion={props.onRetryVersion}
            onSelectVersion={props.onSelectVersion}
            version={version}
            versionIndex={versionIndex}
          />
        ))}
      </div>

      {anonymous && props.onArenaVote ? (
        <PlaygroundArenaVoteBar
          disabled={
            props.isGenerating || hasPendingParallelVersions(props.message)
          }
          instanceSummary={props.arenaInstanceSummary}
          onVote={(choice, note) =>
            props.onArenaVote?.(props.message.key, choice, note)
          }
          personalSummary={props.arenaPersonalSummary}
          vote={props.arenaVote}
        />
      ) : null}
    </div>
  )
}
