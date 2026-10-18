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
import { FileCode2, FileText, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { getServerMessage } from '@/lib/server-error-message'

import type { PlaygroundArtifactKind } from '../../artifact-api'
import type { CapturedArtifactSource } from '../../hooks/use-playground-artifacts'
import { getPlaygroundCodeSelections } from '../../lib/artifact-utils'

interface PlaygroundArtifactSourceSheetProps {
  source: CapturedArtifactSource | null
  isSaving: boolean
  error: unknown
  hasRetry: boolean
  onRetry: () => Promise<boolean>
  onOpenChange: (open: boolean) => void
  onCreate: (
    selection: {
      kind: PlaygroundArtifactKind
      title: string
      language: string
      content: string
      codeBlockIndex?: number
    },
    source: CapturedArtifactSource
  ) => Promise<boolean>
}

export function PlaygroundArtifactSourceSheet(
  props: PlaygroundArtifactSourceSheetProps
) {
  const { t } = useTranslation()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const visibleContent = props.source?.visibleContent ?? ''
  const codeBlocks = useMemo(
    () => getPlaygroundCodeSelections(visibleContent),
    [visibleContent]
  )

  const createArtifact = async (
    selection: {
      kind: PlaygroundArtifactKind
      title: string
      language: string
      content: string
      codeBlockIndex?: number
    },
    key: string
  ) => {
    if (!props.source || pendingKey) return
    setPendingKey(key)
    const created = await props.onCreate(selection, props.source)
    setPendingKey(null)
    if (created) props.onOpenChange(false)
  }

  const retryCreate = async () => {
    setPendingKey('retry')
    const created = await props.onRetry()
    setPendingKey(null)
    if (created) props.onOpenChange(false)
  }

  return (
    <Sheet open={props.source !== null} onOpenChange={props.onOpenChange}>
      <SheetContent className='w-full gap-0 p-0 sm:max-w-xl' side='right'>
        <SheetHeader className='border-b'>
          <SheetTitle>{t('Create an artifact')}</SheetTitle>
          <SheetDescription>
            {t(
              'Choose the complete visible answer or one code block to save independently.'
            )}
          </SheetDescription>
        </SheetHeader>
        <div className='flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4'>
          {Boolean(props.error) && (
            <ErrorState
              className='min-h-0 p-3'
              title={t('Unable to load or save Playground artifacts.')}
              description={getServerMessage(props.error)}
              action={
                props.hasRetry ? (
                  <Button
                    disabled={pendingKey !== null}
                    onClick={() => void retryCreate()}
                    type='button'
                    variant='outline'
                  >
                    {t('Retry same request')}
                  </Button>
                ) : undefined
              }
            />
          )}
          <Button
            className='h-auto justify-start p-4 text-left whitespace-normal'
            disabled={
              pendingKey !== null || props.isSaving || !visibleContent.trim()
            }
            onClick={() =>
              void createArtifact(
                {
                  kind: 'markdown',
                  title: t('New Markdown artifact'),
                  language: 'markdown',
                  content: visibleContent,
                },
                'markdown'
              )
            }
            type='button'
            variant='outline'
          >
            {pendingKey === 'markdown' || props.isSaving ? (
              <Loader2 className='animate-spin' />
            ) : (
              <FileText />
            )}
            <span className='grid gap-1'>
              <span className='font-medium'>
                {t('Save answer as Markdown')}
              </span>
              <span className='text-muted-foreground text-xs'>
                {t('Save the visible answer without reasoning text.')}
              </span>
            </span>
          </Button>
          <div className='grid gap-2'>
            <h3 className='text-sm font-medium'>{t('Code blocks')}</h3>
            {codeBlocks.length === 0 ? (
              <p className='text-muted-foreground text-sm'>
                {t('No code blocks found in this answer.')}
              </p>
            ) : (
              codeBlocks.map((block) => {
                const key = `code-${block.index}`
                // An html or svg fence is previewable in the sandbox, so it is
                // stored as that kind instead of a generic code artifact.
                let kind: PlaygroundArtifactKind = 'code'
                if (block.language === 'html') kind = 'html'
                if (block.language === 'svg') kind = 'svg'
                return (
                  <Button
                    className='h-auto justify-start p-3 text-left whitespace-normal'
                    disabled={pendingKey !== null || props.isSaving}
                    key={key}
                    onClick={() =>
                      void createArtifact(
                        {
                          kind,
                          title: t('New {{language}} artifact', {
                            language: block.language,
                          }),
                          language: block.language,
                          content: block.content,
                          codeBlockIndex: block.index,
                        },
                        key
                      )
                    }
                    type='button'
                    variant='outline'
                  >
                    {pendingKey === key ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <FileCode2 />
                    )}
                    <span className='truncate'>{block.label}</span>
                  </Button>
                )
              })
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
