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
import {
  Check,
  Copy,
  Edit,
  FileCode2,
  FileText,
  Frame,
  GitBranch,
  Image as ImageIcon,
  MoreHorizontal,
  Play,
  Quote,
  RefreshCw,
  Trash2,
  Video,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { MESSAGE_ACTION_LABELS } from '../../constants'
import { useMessageActionGuard } from '../../hooks/use-message-action-guard'
import {
  getMessageActionState,
  getMessageActionsVisibilityClass,
} from '../../lib'
import type { Message } from '../../types'
import { MessageActionButton } from './message-action-button'

interface MessageActionsProps {
  message: Message
  onCopy?: (message: Message) => void
  /** Sets the message as the quote of the next composer turn. */
  onQuote?: (message: Message) => void
  /** Copies the conversation up to this message into a new conversation. */
  onFork?: (message: Message) => void
  onReadAloud?: (message: Message) => void
  onRegenerate?: (message: Message) => void
  /** Offered when the active version was cut short and can be continued. */
  onContinue?: (message: Message) => void
  canContinue?: boolean
  onToggleSource?: (message: Message) => void
  onEdit?: (message: Message) => void
  onDelete?: (message: Message) => void
  onCreateArtifact?: (message: Message) => void
  onSendToCanvas?: (message: Message) => void
  /** Hands the message prompt and reference images to the canvas generation. */
  onGenerateMedia?: (message: Message, kind: 'image' | 'video') => void
  isSourceVisible?: boolean
  isGenerating?: boolean
  alwaysVisible?: boolean
  className?: string
}

type MessageActionItem = {
  className?: string
  disabled?: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
  variant?: 'default' | 'destructive'
}

export function MessageActions({
  message,
  onCopy,
  onQuote,
  onFork,
  onReadAloud,
  onRegenerate,
  onContinue,
  canContinue = false,
  onToggleSource,
  onEdit,
  onDelete,
  onCreateArtifact,
  onSendToCanvas,
  onGenerateMedia,
  isSourceVisible = false,
  isGenerating = false,
  alwaysVisible = false,
  className = '',
}: MessageActionsProps) {
  const { t } = useTranslation()
  const { copiedText, copyToClipboard } = useCopyToClipboard()
  const { guardAction } = useMessageActionGuard(isGenerating)

  const { content, hasContent, isAssistant, isLoading, isUser } =
    getMessageActionState(message)
  const isCopied = copiedText === content

  const handleCopy = () => {
    if (!content) {
      toast.warning(t(MESSAGE_ACTION_LABELS.NO_CONTENT))
      return
    }
    copyToClipboard(content)
    onCopy?.(message)
  }

  const handleRegenerate = guardAction(() => onRegenerate?.(message))
  const handleToggleSource = () => onToggleSource?.(message)
  const handleEdit = guardAction(() => onEdit?.(message))
  const handleDelete = guardAction(() => onDelete?.(message))

  const visibilityClass = getMessageActionsVisibilityClass(alwaysVisible)
  const actions: MessageActionItem[] = []

  if (hasContent) {
    actions.push({
      className: isCopied ? 'text-green-600' : '',
      icon: isCopied ? Check : Copy,
      label: isCopied
        ? MESSAGE_ACTION_LABELS.COPIED
        : MESSAGE_ACTION_LABELS.COPY,
      onClick: handleCopy,
    })
  }

  if (hasContent && !isLoading && message.status !== 'error' && onQuote) {
    actions.push({
      icon: Quote,
      label: MESSAGE_ACTION_LABELS.QUOTE,
      onClick: () => onQuote(message),
    })
  }

  // Forking only copies the history; it stays available for any message and is
  // blocked while a generation owns the workspace.
  if (onFork) {
    actions.push({
      disabled: isGenerating,
      icon: GitBranch,
      label: MESSAGE_ACTION_LABELS.FORK,
      onClick: guardAction(() => onFork(message)),
    })
  }

  if (hasContent && !isLoading && message.status !== 'error' && onReadAloud) {
    actions.push({
      disabled: isGenerating,
      icon: Volume2,
      label: MESSAGE_ACTION_LABELS.READ_ALOUD,
      onClick: guardAction(() => onReadAloud(message)),
    })
  }

  if (
    isAssistant &&
    hasContent &&
    !isLoading &&
    message.status !== 'error' &&
    message.isContentComplete !== false &&
    onCreateArtifact
  ) {
    actions.push({
      disabled: isGenerating,
      icon: FileText,
      label: 'Create an artifact',
      onClick: guardAction(() => onCreateArtifact(message)),
    })
  }

  if (
    hasContent &&
    !isLoading &&
    message.status !== 'error' &&
    onSendToCanvas
  ) {
    actions.push({
      icon: Frame,
      label: MESSAGE_ACTION_LABELS.SEND_TO_CANVAS,
      onClick: () => onSendToCanvas(message),
    })
  }

  if (
    hasContent &&
    !isLoading &&
    message.status !== 'error' &&
    onGenerateMedia
  ) {
    actions.push({
      disabled: isGenerating,
      icon: ImageIcon,
      label: MESSAGE_ACTION_LABELS.GENERATE_IMAGE,
      onClick: guardAction(() => onGenerateMedia(message, 'image')),
    })
    actions.push({
      disabled: isGenerating,
      icon: Video,
      label: MESSAGE_ACTION_LABELS.GENERATE_VIDEO,
      onClick: guardAction(() => onGenerateMedia(message, 'video')),
    })
  }

  if (isAssistant && hasContent && !isLoading && onToggleSource) {
    actions.push({
      icon: FileCode2,
      label: isSourceVisible
        ? MESSAGE_ACTION_LABELS.SHOW_PREVIEW
        : MESSAGE_ACTION_LABELS.SHOW_SOURCE,
      onClick: handleToggleSource,
    })
  }

  if ((isAssistant || isUser) && hasContent && !isLoading && onRegenerate) {
    actions.push({
      disabled: isGenerating,
      icon: RefreshCw,
      label: MESSAGE_ACTION_LABELS.REGENERATE,
      onClick: handleRegenerate,
    })
  }

  if (
    canContinue &&
    isAssistant &&
    hasContent &&
    !isLoading &&
    message.status !== 'error' &&
    onContinue
  ) {
    actions.push({
      disabled: isGenerating,
      icon: Play,
      label: 'Continue generation',
      onClick: guardAction(() => onContinue(message)),
    })
  }

  if (hasContent && onEdit) {
    actions.push({
      disabled: isGenerating,
      icon: Edit,
      label: MESSAGE_ACTION_LABELS.EDIT,
      onClick: handleEdit,
    })
  }

  if (onDelete) {
    actions.push({
      disabled: isGenerating,
      icon: Trash2,
      label: MESSAGE_ACTION_LABELS.DELETE,
      onClick: handleDelete,
      variant: 'destructive',
    })
  }

  if (actions.length === 0) return null

  return (
    <>
      <TooltipProvider delay={300}>
        <div
          className={`hidden items-center gap-0.5 transition-opacity md:flex ${visibilityClass} ${className}`}
        >
          {actions.map((action) => (
            <MessageActionButton
              className={action.className}
              disabled={action.disabled}
              icon={action.icon}
              key={action.label}
              label={t(action.label)}
              onClick={action.onClick}
              variant={action.variant}
            />
          ))}
        </div>
      </TooltipProvider>

      <div className={`md:hidden ${className}`}>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t('Open menu')}
                className='data-popup-open:bg-muted text-muted-foreground hover:text-foreground size-11'
                size='icon'
                variant='ghost'
              />
            }
          >
            <MoreHorizontal className='size-4' />
            <span className='sr-only'>{t('Open menu')}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-44'>
            {actions.map((action) => {
              const Icon = action.icon

              return (
                <DropdownMenuItem
                  className='min-h-11'
                  disabled={action.disabled}
                  key={action.label}
                  onClick={action.onClick}
                  variant={action.variant}
                >
                  {t(action.label)}
                  <DropdownMenuShortcut>
                    <Icon className='size-4' />
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
