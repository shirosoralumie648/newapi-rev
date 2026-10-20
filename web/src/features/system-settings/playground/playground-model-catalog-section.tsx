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
import { FileJson } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { JsonCodeEditor } from '@/components/json-code-editor'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

import { SettingsForm } from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdatePlaygroundModelCatalog } from '../hooks/use-update-option'
import {
  canonicalPlaygroundModelCatalogJson,
  findPlaygroundModelCatalogJsonError,
  normalizePlaygroundModelCatalogJson,
  PLAYGROUND_MODEL_CATALOG_EXAMPLE_JSON,
} from './playground-model-catalog-fields'

type PlaygroundModelCatalogSectionProps = {
  catalogJson: string
}

/**
 * The catalog is one nested editorial document, so it is edited as JSON rather
 * than as a long chain of per-field dialogs. The server validates every bound,
 * group id and model reference before replacing the working catalog; this
 * section only catches structural mistakes and keeps the draft for retry.
 */
export function PlaygroundModelCatalogSection(
  props: PlaygroundModelCatalogSectionProps
) {
  const { t } = useTranslation()
  const updateCatalog = useUpdatePlaygroundModelCatalog()
  const baseline = useMemo(
    () => normalizePlaygroundModelCatalogJson(props.catalogJson),
    [props.catalogJson]
  )
  const [value, setValue] = useState(baseline)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValue(baseline)
    setError(null)
  }, [baseline])

  const handleSave = async () => {
    const nextError = findPlaygroundModelCatalogJsonError(value)
    setError(nextError)
    if (nextError) return
    const serialized = canonicalPlaygroundModelCatalogJson(value)
    if (serialized === baseline) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      // The structural check above already proved this parses; the endpoint
      // validates bounds and references on the same object it stores.
      await updateCatalog.mutateAsync({
        catalog: JSON.parse(serialized) as Record<string, unknown>,
      })
    } catch {
      // The mutation already surfaced the failure; keep the draft for retry.
    }
  }

  return (
    <SettingsSection title={t('Playground Model Catalog')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateCatalog.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save model catalog'
        />

        <div className='space-y-1'>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Curate the models shown in the Playground selector with recommended groups, display names, descriptions, icons, new-conversation sampling defaults, capability tags and display limits.'
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Models missing from the catalog stay available under Other. Set hidden on an entry to remove its model from the Playground selector without changing the account model list.'
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t(
              'A group override replaces the global catalog for that user group; leave group_overrides empty to use the global catalog everywhere.'
            )}
          </p>
        </div>

        <div className='space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <Label htmlFor='playground-model-catalog-json'>
              {t('Model catalog JSON')}
            </Label>
            <Button
              onClick={() => setValue(PLAYGROUND_MODEL_CATALOG_EXAMPLE_JSON)}
              size='sm'
              type='button'
              variant='outline'
            >
              <FileJson data-icon='inline-start' />
              {t('Insert example')}
            </Button>
          </div>
          <JsonCodeEditor
            aria-invalid={error ? true : undefined}
            ariaLabel={t('Model catalog JSON')}
            heightClassName='h-96 min-h-96 max-h-96'
            id='playground-model-catalog-json'
            onChange={(nextValue) => {
              setValue(nextValue)
              if (error) setError(null)
            }}
            placeholder={PLAYGROUND_MODEL_CATALOG_EXAMPLE_JSON}
            value={value}
          />
          {error && <p className='text-destructive text-sm'>{t(error)}</p>}
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
