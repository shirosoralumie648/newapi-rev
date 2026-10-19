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
import { Code2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CodeBlock } from '@/components/ai-elements/code-block'
import { CopyButton } from '@/components/copy-button'
import { EmptyState } from '@/components/empty-state'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import {
  buildPlaygroundRequestCode,
  type PlaygroundCapturedRequest,
  type PlaygroundRequestCodeTab,
  resolvePlaygroundRequestBaseUrl,
} from '../../lib/developer/request-code'
import type { ChatCompletionRequest } from '../../types'

interface PlaygroundRequestCodeTabDefinition {
  value: PlaygroundRequestCodeTab
  label: string
  copyLabel: string
  language: string
}

const REQUEST_CODE_TABS: PlaygroundRequestCodeTabDefinition[] = [
  {
    value: 'messages',
    label: 'Messages JSON',
    copyLabel: 'Copy Messages JSON',
    language: 'json',
  },
  {
    value: 'curl',
    label: 'cURL',
    copyLabel: 'Copy cURL',
    language: 'bash',
  },
  {
    value: 'python',
    label: 'Python',
    copyLabel: 'Copy Python',
    language: 'python',
  },
  {
    value: 'node',
    label: 'Node.js',
    copyLabel: 'Copy Node.js',
    language: 'javascript',
  },
]

interface PlaygroundRequestViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Most recent captured send, or null before the first message. */
  request: PlaygroundCapturedRequest | null
}

function RequestCodePanel(props: {
  baseUrl: string
  payload: ChatCompletionRequest
  tab: PlaygroundRequestCodeTabDefinition
}) {
  const { t } = useTranslation()
  const code = buildPlaygroundRequestCode(
    props.tab.value,
    props.payload,
    props.baseUrl
  )
  const label = t(props.tab.copyLabel)

  return (
    <CodeBlock
      code={code}
      language={props.tab.language}
      maxExpandedLines={40}
      showToolbar
      title={t(props.tab.label)}
    >
      <CopyButton aria-label={label} tooltip={label} value={code} />
    </CodeBlock>
  )
}

/**
 * Read-only inspector of the final request the workspace built. It shows the
 * captured payload and generates copy-ready code for the OpenAI-compatible
 * endpoint; attachments are always replaced by placeholders, so no base64
 * bytes or API tokens can leak into the clipboard.
 */
export function PlaygroundRequestViewer(props: PlaygroundRequestViewerProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<PlaygroundRequestCodeTab>('messages')
  const baseUrl = resolvePlaygroundRequestBaseUrl()
  const payload = props.request ? props.request.payload : null

  return (
    <Sheet onOpenChange={props.onOpenChange} open={props.open}>
      <SheetContent className='w-full gap-0 sm:max-w-3xl' side='right'>
        <SheetHeader className='border-b pr-12'>
          <SheetTitle>{t('Request preview')}</SheetTitle>
          <SheetDescription>
            {t(
              'The exact request built by the last send, ready to copy into your own code.'
            )}
          </SheetDescription>
        </SheetHeader>
        {payload ? (
          <Tabs
            className='min-h-0 flex-1 gap-0'
            onValueChange={(value) => setTab(value as PlaygroundRequestCodeTab)}
            value={tab}
          >
            <div className='shrink-0 space-y-2 border-b px-4 py-2'>
              <TabsList className='grid w-full grid-cols-4'>
                {REQUEST_CODE_TABS.map((definition) => (
                  <TabsTrigger
                    className='text-xs'
                    key={definition.value}
                    value={definition.value}
                  >
                    {t(definition.label)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <p className='text-muted-foreground text-xs'>
                {t(
                  'Exports target the OpenAI-compatible /v1/chat/completions endpoint with a placeholder key. Attachments are replaced by file placeholders instead of base64 bytes.'
                )}
              </p>
              {payload.group !== undefined && (
                <p className='text-muted-foreground text-xs'>
                  {t(
                    '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.'
                  )}
                </p>
              )}
            </div>
            <div className='min-h-0 flex-1 overflow-y-auto'>
              {REQUEST_CODE_TABS.map((definition) => (
                <TabsContent
                  className='px-4 pb-4'
                  key={definition.value}
                  value={definition.value}
                >
                  <RequestCodePanel
                    baseUrl={baseUrl}
                    payload={payload}
                    tab={definition}
                  />
                </TabsContent>
              ))}
            </div>
          </Tabs>
        ) : (
          <div className='flex min-h-0 flex-1 items-center justify-center p-4'>
            <EmptyState
              icon={Code2}
              title={t('No request captured')}
              description={t(
                'Send a message to inspect the exact request payload.'
              )}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
