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
import { FileCode2, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import type { PlaygroundArtifactSummary } from '../../artifact-api'

interface PlaygroundArtifactLinksProps {
  artifacts: PlaygroundArtifactSummary[]
  onOpenArtifact: (artifact: PlaygroundArtifactSummary) => void
}

/**
 * The lightweight artifact preview kept in the conversation stream. It is not
 * the artifact browser: each chip only names a saved artifact and opens the
 * canvas artifact view, where versions, sandbox preview and export live.
 */
export function PlaygroundArtifactLinks(props: PlaygroundArtifactLinksProps) {
  const { t } = useTranslation()
  if (props.artifacts.length === 0) return null
  const visible = props.artifacts.slice(0, 3)
  return (
    <section
      aria-label={t('Saved artifacts')}
      className='mb-3 flex flex-wrap items-center gap-1.5'
    >
      <span className='text-muted-foreground text-xs'>
        {t('Saved artifacts')}
      </span>
      {visible.map((artifact) => (
        <Button
          aria-label={`${t('Open canvas')}: ${artifact.title}`}
          key={artifact.id}
          onClick={() => props.onOpenArtifact(artifact)}
          size='sm'
          type='button'
          variant='outline'
        >
          {artifact.kind === 'code' ? (
            <FileCode2 aria-hidden='true' />
          ) : (
            <FileText aria-hidden='true' />
          )}
          <span className='max-w-40 truncate'>{artifact.title}</span>
        </Button>
      ))}
      {props.artifacts.length > visible.length ? (
        <span className='text-muted-foreground text-xs'>
          +{props.artifacts.length - visible.length}
        </span>
      ) : null}
    </section>
  )
}
