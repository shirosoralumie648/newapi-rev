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

import type { MessageAttachment } from '../../types'
import { useMessageAttachmentPreviewUrl } from './message-attachment-list'

/**
 * Plays the cached read-aloud audio of one message version. The bytes load
 * through the owner-scoped attachment endpoint; the player is rendered even
 * before they arrive so a saved recording is always visible.
 */
export function MessageSpeech({ speech }: { speech: MessageAttachment }) {
  const { t } = useTranslation()
  const url = useMessageAttachmentPreviewUrl(speech)

  return (
    <audio
      aria-label={speech.filename || t('Read aloud')}
      className='my-2 h-9 w-full max-w-sm'
      controls
      src={url}
    />
  )
}
