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
import { useTranslation } from 'react-i18next'

import { ShareLinkDialog } from '@/components/share-link-dialog'

import {
  createPlaygroundSessionShare,
  revokePlaygroundSessionShare,
} from '../../share-api'

interface PlaygroundSessionShareDialogProps {
  /** Canonical server id of the conversation to share. */
  sessionId: string
  /** Conversation title, used for the trigger's accessible name. */
  title: string
  disabled?: boolean
  className?: string
}

/**
 * Owner-side controls for a conversation's public read-only link. The generic
 * share dialog owns the expiry picker, one-time URL display and revoke flow;
 * this wrapper only binds them to the conversation endpoints and copy.
 */
export function PlaygroundSessionShareDialog(
  props: PlaygroundSessionShareDialogProps
) {
  const { t } = useTranslation()
  return (
    <ShareLinkDialog
      create={(expiresInDays) =>
        createPlaygroundSessionShare(props.sessionId, expiresInDays)
      }
      createHint={t(
        'Creating a new link revokes all previous links for this conversation.'
      )}
      description={t(
        'Anyone with the link can read this conversation without signing in. The link is read-only and can be revoked at any time.'
      )}
      disabled={props.disabled}
      revoke={() => revokePlaygroundSessionShare(props.sessionId)}
      title={t('Share conversation')}
      triggerAriaLabel={t('Share {{name}}', { name: props.title })}
      triggerClassName={props.className}
    />
  )
}
