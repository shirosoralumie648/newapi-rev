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
import { BadgeCheck, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import {
  checkJsonAgainstSchema,
  parseStructuredJson,
  type JsonSchemaViolationReason,
} from '../../lib/developer/json-schema'
import type { PlaygroundDeveloperResponseFormat } from '../../types'

/**
 * The mismatch of one schema keyword, worded as the translation key the list
 * renders. `{{detail}}` carries the expected type, property name or bound so
 * the sentence stays short and translatable.
 */
const VIOLATION_MESSAGES: Record<JsonSchemaViolationReason, string> = {
  type: 'Expected {{detail}}',
  required: 'Missing required property "{{detail}}"',
  additionalProperties: 'Unexpected property "{{detail}}"',
  enum: 'Value is not one of the allowed values',
  const: 'Value does not equal the required constant',
  minimum: 'Value is below the minimum {{detail}}',
  maximum: 'Value is above the maximum {{detail}}',
  minLength: 'Text is shorter than {{detail}} characters',
  maxLength: 'Text is longer than {{detail}} characters',
  minItems: 'List has fewer than {{detail}} items',
  maxItems: 'List has more than {{detail}} items',
  anyOf: 'Value matches none of the allowed shapes',
  allOf: 'Value does not match every required shape',
}

type MessageStructuredOutputProps = {
  /** Raw assistant text of the version being previewed. */
  content: string
  /** Response format of the active conversation's developer settings. */
  format: PlaygroundDeveloperResponseFormat
}

/**
 * Parse preview of one structured assistant reply: whether the text is valid
 * JSON and, when the conversation defines a response schema, which keywords of
 * that schema the parsed value does not satisfy. It only reports; the request
 * and the stored message stay unchanged.
 */
export function MessageStructuredOutput(props: MessageStructuredOutputProps) {
  const { t } = useTranslation()
  const [showJson, setShowJson] = useState(false)
  const parsed = useMemo(
    () => parseStructuredJson(props.content),
    [props.content]
  )
  const schema =
    props.format.type === 'json_schema' ? props.format.jsonSchema : undefined
  const check = useMemo(() => {
    if (!parsed.ok || !schema) return null
    return checkJsonAgainstSchema(parsed.value, schema.schema)
  }, [parsed, schema])

  if (!parsed.ok) {
    return (
      <div
        className='border-border/60 bg-muted/30 my-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-4'
        role='status'
      >
        <TriangleAlert
          aria-hidden='true'
          className='mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400'
        />
        <span className='text-muted-foreground'>
          {t(
            'The response is not valid JSON, so the schema check was skipped.'
          )}
        </span>
      </div>
    )
  }

  const violations = check?.violations ?? []
  const matches = check ? check.valid : true
  const prettyJson = JSON.stringify(parsed.value, null, 2)
  let statusText: string
  if (!schema) {
    statusText = t('Response is valid JSON.')
  } else if (matches) {
    statusText = t('Response matches the schema "{{name}}".', {
      name: schema.name,
    })
  } else {
    statusText = t('Response does not match the schema ({{issues}} issues).', {
      issues: violations.length,
    })
  }

  return (
    <div className='border-border/60 my-2 grid gap-2 rounded-lg border px-3 py-2 text-xs leading-4'>
      <div className='flex items-start gap-2' role='status'>
        {matches ? (
          <BadgeCheck
            aria-hidden='true'
            className='mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
          />
        ) : (
          <TriangleAlert
            aria-hidden='true'
            className='mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400'
          />
        )}
        <span
          className={
            matches
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-amber-700 dark:text-amber-400'
          }
        >
          {statusText}
        </span>
      </div>

      {violations.length > 0 && (
        <ul className='text-muted-foreground grid gap-1'>
          {violations.map((violation, index) => (
            <li
              className='flex flex-wrap items-baseline gap-x-1.5'
              key={`${violation.path}-${violation.reason}-${index}`}
            >
              <code className='bg-muted/50 rounded px-1 font-mono text-[0.95em]'>
                {violation.path}
              </code>
              <span>
                {t(VIOLATION_MESSAGES[violation.reason], {
                  detail: violation.detail ?? '',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          aria-expanded={showJson}
          className='h-6 px-1.5 text-xs'
          onClick={() => setShowJson((current) => !current)}
          size='sm'
          type='button'
          variant='ghost'
        >
          {showJson ? t('Hide formatted JSON') : t('View formatted JSON')}
        </Button>
      </div>

      {showJson && (
        <pre className='bg-muted/40 max-h-64 overflow-auto rounded-md p-2 font-mono text-[0.95em] whitespace-pre'>
          {prettyJson}
        </pre>
      )}
    </div>
  )
}
