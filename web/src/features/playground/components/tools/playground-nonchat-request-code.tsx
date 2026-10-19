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

import { CodeBlock } from '@/components/ai-elements/code-block'
import { CopyButton } from '@/components/copy-button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { resolvePlaygroundRequestBaseUrl } from '../../lib/developer/request-code'
import {
  buildNonChatRequestCode,
  type NonChatRequestCodeTab,
} from '../../lib/tools/nonchat-request-code'

const REQUEST_CODE_TABS: {
  value: NonChatRequestCodeTab
  label: string
  copyLabel: string
  language: string
}[] = [
  { value: 'curl', label: 'cURL', copyLabel: 'Copy cURL', language: 'bash' },
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
  { value: 'json', label: 'JSON', copyLabel: 'Copy JSON', language: 'json' },
]

/**
 * PG2-01-compatible export of the request the panel would send. It targets the
 * public /v1 endpoint, drops the Playground-only group field and always uses a
 * placeholder key, so no real token can leak through the clipboard.
 */
export function NonChatRequestCode(props: {
  canonicalPath: string
  body: Record<string, unknown>
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<NonChatRequestCodeTab>('curl')
  const baseUrl = resolvePlaygroundRequestBaseUrl()

  return (
    <div className='space-y-2'>
      <p className='text-muted-foreground text-xs'>
        {t(
          'These snippets target the public /v1 endpoint with a placeholder key.'
        )}
      </p>
      <Tabs
        className='gap-2'
        onValueChange={(value) => {
          if (
            value === 'curl' ||
            value === 'python' ||
            value === 'node' ||
            value === 'json'
          ) {
            setTab(value)
          }
        }}
        value={tab}
      >
        <TabsList>
          {REQUEST_CODE_TABS.map((definition) => (
            <TabsTrigger key={definition.value} value={definition.value}>
              {t(definition.label)}
            </TabsTrigger>
          ))}
        </TabsList>
        {REQUEST_CODE_TABS.map((definition) => {
          const code = buildNonChatRequestCode(
            definition.value,
            props.canonicalPath,
            props.body,
            baseUrl
          )
          const label = t(definition.copyLabel)
          return (
            <TabsContent
              key={definition.value}
              keepMounted
              value={definition.value}
            >
              <CodeBlock
                code={code}
                language={definition.language}
                maxExpandedLines={40}
                showToolbar
                title={t(definition.label)}
              >
                <CopyButton aria-label={label} tooltip={label} value={code} />
              </CodeBlock>
            </TabsContent>
          )
        })}
      </Tabs>
    </div>
  )
}
