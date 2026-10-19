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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TagInput } from '@/components/tag-input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { MAX_SESSION_TAGS, MAX_SESSION_TAG_LENGTH } from '../../constants'
import { normalizeSessionTags } from '../../lib/session-organization'
import type { PlaygroundSession } from '../../types'

interface PlaygroundSessionTagsDialogProps {
  session: PlaygroundSession
  onOpenChange: (open: boolean) => void
  onSave: (tags: string[]) => void
}

/**
 * Edits the complete tag list of one conversation. The same bounds are
 * enforced again by the server; this dialog keeps the common path obvious
 * without treating local validation as the authority.
 */
export function PlaygroundSessionTagsDialog(
  props: PlaygroundSessionTagsDialogProps
) {
  const { t } = useTranslation()
  const [tags, setTags] = useState<string[]>(() => [...props.session.tags])
  const displayTitle =
    props.session.title === 'New conversation'
      ? t('New conversation')
      : props.session.title

  const save = () => {
    props.onSave(normalizeSessionTags(tags))
    props.onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('Conversation tags')}</DialogTitle>
          <DialogDescription>
            {t(
              'Organize "{{name}}" with up to {{count}} labels. Each label can contain up to {{length}} characters.',
              {
                name: displayTitle,
                count: MAX_SESSION_TAGS,
                length: MAX_SESSION_TAG_LENGTH,
              }
            )}
          </DialogDescription>
        </DialogHeader>
        <TagInput
          maxTagLength={MAX_SESSION_TAG_LENGTH}
          maxTags={MAX_SESSION_TAGS}
          onChange={setTags}
          placeholder={t('Add a tag...')}
          value={tags}
        />
        <DialogFooter>
          <DialogClose render={<Button type='button' variant='outline' />}>
            {t('Cancel')}
          </DialogClose>
          <Button onClick={save} type='button'>
            {t('Save tags')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
