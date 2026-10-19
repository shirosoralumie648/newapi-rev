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
import { BookIcon } from 'lucide-react'

import {
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '@/components/ai-elements/sources'

import { getKnowledgeCitationSources } from '../../lib'
import type { MessageKnowledgeSnapshot } from '../../types'

type MessageKnowledgeSourcesProps = {
  /** Snapshot of the user turn this reply answers; nothing renders without it. */
  knowledge: MessageKnowledgeSnapshot
  /** Id namespace of the reply, so several replies on screen stay unique. */
  anchorId: string
}

/**
 * Citation list of one reply that retrieved knowledge context: the [n] markers
 * of the answer link to these entries. The entries open by default because a
 * knowledge chunk has no external address — the list itself is the citation
 * target.
 */
export function MessageKnowledgeSources(props: MessageKnowledgeSourcesProps) {
  const sources = getKnowledgeCitationSources(props.knowledge, props.anchorId)
  if (sources.length === 0) return null

  return (
    <Sources defaultOpen>
      <SourcesTrigger count={sources.length} />
      <SourcesContent>
        {sources.map((source) => (
          <span
            className='flex scroll-mt-24 items-center gap-2'
            id={source.id}
            key={source.id}
          >
            <BookIcon aria-hidden='true' className='h-4 w-4 shrink-0' />
            <span className='block font-medium'>{source.label}</span>
          </span>
        ))}
      </SourcesContent>
    </Sources>
  )
}
