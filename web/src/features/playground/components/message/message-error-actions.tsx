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
  ArrowRightLeft,
  CpuIcon,
  Edit,
  Gauge,
  ImageOff,
  LayersIcon,
  RefreshCw,
  Trash2,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import type {
  PlaygroundErrorAction,
  PlaygroundErrorCatalogEntry,
} from '../../lib'
import { MessageActionButton } from './message-action-button'

type CatalogActionCallbacks = {
  onRetry?: () => void
  onOpenContext?: () => void
  onRemoveImages?: () => void
  onChangeModel?: () => void
  onSwitchGroup?: () => void
  onOpenWallet?: () => void
  onUseChatProtocol?: () => void
}

type MessageErrorActionsProps = CatalogActionCallbacks & {
  /** Catalog entry of the error code, when the code is known. */
  catalog?: PlaygroundErrorCatalogEntry | null
  disabled?: boolean
  onDelete?: () => void
  onEditPrompt?: () => void
}

const CATALOG_ACTION_BUTTONS: Record<
  PlaygroundErrorAction,
  { icon: LucideIcon; label: string }
> = {
  retry: { icon: RefreshCw, label: 'Retry' },
  'open-context': { icon: Gauge, label: 'Manage context' },
  'remove-images': { icon: ImageOff, label: 'Remove images' },
  'change-model': { icon: CpuIcon, label: 'Change model' },
  'switch-group': { icon: LayersIcon, label: 'Switch group' },
  'open-wallet': { icon: Wallet, label: 'Open wallet' },
  'use-chat-protocol': {
    icon: ArrowRightLeft,
    label: 'Use Chat Completions',
  },
}

export function MessageErrorActions(props: MessageErrorActionsProps) {
  const { t } = useTranslation()
  const callbacks: Partial<Record<PlaygroundErrorAction, () => void>> = {
    retry: props.onRetry,
    'open-context': props.onOpenContext,
    'remove-images': props.onRemoveImages,
    'change-model': props.onChangeModel,
    'switch-group': props.onSwitchGroup,
    'open-wallet': props.onOpenWallet,
    'use-chat-protocol': props.onUseChatProtocol,
  }
  const catalogActions = (props.catalog?.actions ?? []).filter(
    (action) => callbacks[action]
  )
  const showsFallbackRetry = Boolean(props.onRetry) && !props.catalog
  const showsFallbackActions =
    showsFallbackRetry || Boolean(props.onEditPrompt) || Boolean(props.onDelete)

  if (catalogActions.length === 0 && !showsFallbackActions) {
    return null
  }

  return (
    <div className='flex flex-wrap items-center gap-1 pt-2'>
      {catalogActions.map((action) => {
        const { icon: Icon, label } = CATALOG_ACTION_BUTTONS[action]
        return (
          <Button
            className='h-7 px-2 text-xs'
            disabled={props.disabled}
            key={action}
            onClick={callbacks[action]}
            size='sm'
            type='button'
            variant='outline'
          >
            <Icon aria-hidden='true' className='size-3.5' />
            {t(label)}
          </Button>
        )
      })}

      {showsFallbackRetry && (
        <MessageActionButton
          disabled={props.disabled}
          icon={RefreshCw}
          label={t('Retry')}
          onClick={props.onRetry ?? (() => undefined)}
        />
      )}

      {props.onEditPrompt && (
        <MessageActionButton
          disabled={props.disabled}
          icon={Edit}
          label={t('Edit')}
          onClick={props.onEditPrompt}
        />
      )}

      {props.onDelete && (
        <MessageActionButton
          disabled={props.disabled}
          icon={Trash2}
          label={t('Delete')}
          onClick={props.onDelete}
          variant='destructive'
        />
      )}
    </div>
  )
}
