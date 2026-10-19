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
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { PLAYGROUND_PROTOCOL_OPTIONS } from '../../constants'
import type { PlaygroundProtocol } from '../../types'

interface PlaygroundProtocolSelectProps {
  disabled?: boolean
  value: PlaygroundProtocol
  onChange: (protocol: PlaygroundProtocol) => void
  /** Payload fields the chosen protocol does not send; reported as a warning. */
  unsupportedFields?: string[]
}

function isPlaygroundProtocol(value: unknown): value is PlaygroundProtocol {
  return value === 'chat' || value === 'responses' || value === 'messages'
}

/**
 * Protocol of the next send. The choice is stored in the conversation config,
 * so switching protocols and resending the same prompt compares the three wire
 * shapes without touching the message history.
 */
export function PlaygroundProtocolSelect(props: PlaygroundProtocolSelectProps) {
  const { t } = useTranslation()
  const items = PLAYGROUND_PROTOCOL_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }))
  const unsupported = props.unsupportedFields ?? []
  const warning =
    unsupported.length > 0
      ? t('Not sent with this protocol: {{fields}}', {
          fields: unsupported.join(', '),
        })
      : ''

  return (
    <span className='inline-flex items-center gap-1'>
      <Select
        disabled={props.disabled}
        items={items}
        onValueChange={(value: unknown) => {
          if (isPlaygroundProtocol(value)) props.onChange(value)
        }}
        value={props.value}
      >
        <SelectTrigger
          aria-label={t('API protocol')}
          className='h-8 w-[150px] text-xs'
          size='sm'
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PLAYGROUND_PROTOCOL_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {warning !== '' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span aria-label={warning} className='text-amber-500' role='img'>
                <AlertTriangle aria-hidden='true' size={14} />
              </span>
            }
          />
          <TooltipContent>
            <p>{warning}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
