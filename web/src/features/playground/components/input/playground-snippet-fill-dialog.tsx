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
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  parsePromptTemplateVariables,
  renderPromptTemplate,
  unresolvedPromptTemplateVariables,
} from '../../lib/input/prompt-template'

export type PromptSnippetTarget = 'composer' | 'system'

interface PlaygroundSnippetFillDialogProps {
  content: string
  open: boolean
  target: PromptSnippetTarget
  onOpenChange: (open: boolean) => void
  /** Receives the template with every variable filled in. */
  onConfirm: (rendered: string) => void
}

/**
 * The pre-insert fill panel for a template with variables. Defaults arrive
 * prefilled; a variable without a default must be filled before the template
 * can be inserted. The preview always shows exactly what will be inserted.
 */
export function PlaygroundSnippetFillDialog(
  props: PlaygroundSnippetFillDialogProps
) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, string>>({})

  const variables = useMemo(
    () => parsePromptTemplateVariables(props.content),
    [props.content]
  )

  useEffect(() => {
    if (!props.open) return
    const next: Record<string, string> = {}
    for (const variable of variables) {
      next[variable.name] = variable.hasDefault ? variable.defaultValue : ''
    }
    setValues(next)
  }, [props.open, variables])

  const unresolved = unresolvedPromptTemplateVariables(variables, values)
  const preview = renderPromptTemplate(props.content, values)
  const confirmLabel =
    props.target === 'system' ? t('Insert into system prompt') : t('Insert')

  return (
    <Dialog
      contentClassName='sm:max-w-xl'
      description={t('Fill in the template variables before inserting.')}
      footer={
        <>
          <Button
            onClick={() => props.onOpenChange(false)}
            type='button'
            variant='outline'
          >
            {t('Cancel')}
          </Button>
          <Button
            disabled={unresolved.length > 0}
            onClick={() => props.onConfirm(preview)}
            type='button'
          >
            {confirmLabel}
          </Button>
        </>
      }
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={t('Variables')}
    >
      <div className='grid gap-4'>
        <div className='grid gap-1'>
          <p className='text-muted-foreground text-xs leading-4'>
            {t(
              'Variables use double curly braces around a name, optionally followed by a default after a colon.'
            )}
          </p>
          <div className='text-muted-foreground flex flex-wrap gap-2 font-mono text-[11px]'>
            <code className='bg-muted/50 rounded px-1.5 py-0.5'>
              {'{{topic}}'}
            </code>
            <code className='bg-muted/50 rounded px-1.5 py-0.5'>
              {'{{topic:general}}'}
            </code>
          </div>
        </div>

        {variables.map((variable, index) => (
          <div className='grid gap-2' key={variable.name}>
            <Label htmlFor={`playground-template-variable-${index}`}>
              {variable.name}
              {variable.hasDefault ? (
                <span className='text-muted-foreground text-xs'>
                  {t('Default: {{value}}', { value: variable.defaultValue })}
                </span>
              ) : null}
            </Label>
            <Input
              id={`playground-template-variable-${index}`}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [variable.name]: event.target.value,
                }))
              }
              placeholder={variable.defaultValue || variable.name}
              value={values[variable.name] ?? ''}
            />
          </div>
        ))}

        {unresolved.length > 0 ? (
          <p className='text-destructive text-xs'>
            {t('Fill in every variable that has no default.')}
          </p>
        ) : null}

        <div className='grid gap-2'>
          <span className='text-sm font-medium'>{t('Preview')}</span>
          <pre
            aria-label={t('Preview')}
            className='bg-muted/30 max-h-40 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap'
          >
            {preview}
          </pre>
        </div>
      </div>
    </Dialog>
  )
}
