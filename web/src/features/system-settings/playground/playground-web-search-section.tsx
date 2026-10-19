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
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { FormItem } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  SettingsForm,
  SettingsFormGrid,
  SettingsSwitchField,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdatePlaygroundWebSearch } from '../hooks/use-update-option'
import {
  isNonNegativeNumber,
  parsePlaygroundWebSearch,
  serializePlaygroundWebSearch,
  type PlaygroundWebSearchDraft,
  type PlaygroundWebSearchGroupPriceDraft,
  type PlaygroundWebSearchProvider,
} from './playground-web-search-fields'

const BASE_URL_HINT_KEYS: Record<PlaygroundWebSearchProvider, string> = {
  tavily: 'Leave blank to use https://api.tavily.com.',
  searxng:
    'Required. Enter the public URL of your self-hosted SearXNG instance.',
  brave: 'Leave blank to use https://api.search.brave.com.',
}

export function PlaygroundWebSearchSection(props: { webSearchJson: string }) {
  const { t } = useTranslation()
  const updateSearch = useUpdatePlaygroundWebSearch()
  const baseline = useMemo(
    () => parsePlaygroundWebSearch(props.webSearchJson),
    [props.webSearchJson]
  )
  const baselineJson = useMemo(
    () => serializePlaygroundWebSearch(baseline.draft, baseline.groupPrices),
    [baseline]
  )

  const [draft, setDraft] = useState<PlaygroundWebSearchDraft>(
    () => baseline.draft
  )
  const [groupPrices, setGroupPrices] = useState<
    PlaygroundWebSearchGroupPriceDraft[]
  >(() => baseline.groupPrices)
  const [apiKeyDraft, setAPIKeyDraft] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    const next = parsePlaygroundWebSearch(props.webSearchJson)
    setDraft(next.draft)
    setGroupPrices(next.groupPrices)
    setAPIKeyDraft('')
    setNewGroup('')
    setErrors({})
  }, [props.webSearchJson])

  const handleAddGroup = () => {
    const group = newGroup.trim()
    if (!group || groupPrices.some((entry) => entry.group === group)) {
      setNewGroup('')
      return
    }
    setGroupPrices((current) => [...current, { group, priceUSDPerCall: '0' }])
    setNewGroup('')
  }

  const handleSave = async () => {
    const nextErrors: Record<string, string> = {}
    const apiKey = apiKeyDraft.trim()
    const baseURL = draft.baseURL.trim()

    if (!isNonNegativeNumber(draft.priceUSDPerCall)) {
      nextErrors.price = t('Must be greater than or equal to 0')
    }
    if (baseURL) {
      let parsedURL: URL | null = null
      try {
        parsedURL = new URL(baseURL)
      } catch {
        parsedURL = null
      }
      if (
        /\s/.test(baseURL) ||
        !parsedURL ||
        (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') ||
        parsedURL.host === '' ||
        parsedURL.username !== '' ||
        parsedURL.password !== '' ||
        parsedURL.search !== '' ||
        parsedURL.hash !== ''
      ) {
        nextErrors.baseURL = t(
          'Enter an http(s) URL without credentials, query parameters or fragments.'
        )
      }
    } else if (draft.provider === 'searxng') {
      nextErrors.baseURL = t('A SearXNG base URL is required.')
    }
    if (apiKey.length > 4096 || /[\u0000\r\n]/.test(apiKey)) {
      nextErrors.apiKey = t('The API key is invalid.')
    }
    groupPrices.forEach((entry) => {
      if (!isNonNegativeNumber(entry.priceUSDPerCall)) {
        nextErrors[`group-${entry.group}`] = t(
          'Must be greater than or equal to 0'
        )
      }
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const serialized = serializePlaygroundWebSearch(draft, groupPrices)
    if (serialized === baselineJson && !apiKey) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      await updateSearch.mutateAsync({
        web_search: serialized,
        ...(apiKey ? { api_key: apiKey } : {}),
      })
      setAPIKeyDraft('')
    } catch {
      // The mutation already surfaced the failure; keep the draft for retry.
    }
  }

  const providerItems = [
    { value: 'tavily', label: t('Tavily') },
    { value: 'searxng', label: t('SearXNG (self-hosted)') },
    { value: 'brave', label: t('Brave Search') },
  ]

  return (
    <SettingsSection title={t('Playground Web Search')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateSearch.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save web search'
        />

        <div className='space-y-6'>
          <SettingsSwitchField
            controlId='playground-web-search-enabled'
            checked={draft.enabled}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, enabled: checked }))
            }
            label={t('Enable web search for Playground turns')}
            description={t(
              'Show a Globe toggle in the composer. The gateway calls the provider and injects normalized results into that turn; a hosted provider also needs a stored API key, and SearXNG needs a base URL.'
            )}
          />

          <SettingsFormGrid>
            <FormItem>
              <Label htmlFor='playground-web-search-provider'>
                {t('Search provider')}
              </Label>
              <Select
                items={providerItems}
                value={draft.provider}
                onValueChange={(value) => {
                  if (
                    value !== 'tavily' &&
                    value !== 'searxng' &&
                    value !== 'brave'
                  ) {
                    return
                  }
                  setDraft((current) => ({ ...current, provider: value }))
                }}
              >
                <SelectTrigger
                  className='w-full'
                  id='playground-web-search-provider'
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {providerItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'The gateway supports Tavily, self-hosted SearXNG and Brave Search.'
                )}
              </p>
            </FormItem>

            <FormItem>
              <Label htmlFor='playground-web-search-base-url'>
                {t('Provider base URL')}
              </Label>
              <Input
                aria-invalid={errors.baseURL ? true : undefined}
                id='playground-web-search-base-url'
                maxLength={2048}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    baseURL: event.target.value,
                  }))
                }
                placeholder='https://search.example.com'
                spellCheck={false}
                type='url'
                value={draft.baseURL}
              />
              <p className='text-muted-foreground text-sm'>
                {t(BASE_URL_HINT_KEYS[draft.provider])}
              </p>
              {errors.baseURL && (
                <p className='text-destructive text-sm'>{errors.baseURL}</p>
              )}
            </FormItem>

            <FormItem>
              <Label htmlFor='playground-web-search-api-key'>
                {t('Search provider API key')}
              </Label>
              <Input
                aria-invalid={errors.apiKey ? true : undefined}
                autoComplete='new-password'
                id='playground-web-search-api-key'
                maxLength={4096}
                onChange={(event) => setAPIKeyDraft(event.target.value)}
                placeholder={t('Leave blank to keep the existing key')}
                spellCheck={false}
                type='password'
                value={apiKeyDraft}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Stored on the server and never returned to the browser. Optional for a self-hosted SearXNG instance without authentication.'
                )}
              </p>
              {errors.apiKey && (
                <p className='text-destructive text-sm'>{errors.apiKey}</p>
              )}
            </FormItem>

            <FormItem>
              <Label htmlFor='playground-web-search-price'>
                {t('Web search unit price (USD)')}
              </Label>
              <Input
                aria-invalid={errors.price ? true : undefined}
                id='playground-web-search-price'
                inputMode='decimal'
                min={0}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    priceUSDPerCall: event.target.value,
                  }))
                }
                step='any'
                type='number'
                value={draft.priceUSDPerCall}
              />
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Held on the wallet before the provider call and charged once only when results return. A failed search is refunded.'
                )}
              </p>
              {errors.price && (
                <p className='text-destructive text-sm'>{errors.price}</p>
              )}
            </FormItem>
          </SettingsFormGrid>

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>
                {t('Group search price overrides')}
              </h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Charge one user group a different price per search. A group without an entry uses the global price.'
                )}
              </p>
            </div>

            {groupPrices.map((entry, index) => {
              const errorKey = `group-${entry.group}`
              return (
                <div
                  key={entry.group}
                  className='flex flex-wrap items-end gap-3 rounded-lg border p-4'
                >
                  <FormItem className='min-w-32 flex-1'>
                    <Label
                      htmlFor={`playground-web-search-group-${entry.group}`}
                    >
                      {t('Group')}
                    </Label>
                    <Input
                      disabled
                      id={`playground-web-search-group-${entry.group}`}
                      value={entry.group}
                    />
                  </FormItem>
                  <FormItem className='min-w-32 flex-1'>
                    <Label
                      htmlFor={`playground-web-search-group-price-${entry.group}`}
                    >
                      {t('Price per search (USD)')}
                    </Label>
                    <Input
                      aria-invalid={errors[errorKey] ? true : undefined}
                      id={`playground-web-search-group-price-${entry.group}`}
                      inputMode='decimal'
                      min={0}
                      onChange={(event) =>
                        setGroupPrices((current) =>
                          current.map((item, position) =>
                            position === index
                              ? {
                                  ...item,
                                  priceUSDPerCall: event.target.value,
                                }
                              : item
                          )
                        )
                      }
                      step='any'
                      type='number'
                      value={entry.priceUSDPerCall}
                    />
                    {errors[errorKey] && (
                      <p className='text-destructive text-sm'>
                        {errors[errorKey]}
                      </p>
                    )}
                  </FormItem>
                  <Button
                    aria-label={t('Remove')}
                    onClick={() =>
                      setGroupPrices((current) =>
                        current.filter((_, position) => position !== index)
                      )
                    }
                    size='icon-sm'
                    type='button'
                    variant='ghost'
                  >
                    <Trash2 aria-hidden='true' />
                  </Button>
                </div>
              )
            })}

            <div className='flex flex-wrap items-end gap-3 rounded-lg border border-dashed p-4'>
              <FormItem className='min-w-32 flex-1'>
                <Label htmlFor='playground-web-search-new-group'>
                  {t('Group')}
                </Label>
                <Input
                  id='playground-web-search-new-group'
                  maxLength={128}
                  onChange={(event) => setNewGroup(event.target.value)}
                  placeholder={t('Enter a group name')}
                  value={newGroup}
                />
              </FormItem>
              <Button
                onClick={handleAddGroup}
                size='sm'
                type='button'
                variant='outline'
              >
                <Plus aria-hidden='true' className='h-4 w-4' />
                {t('Add group')}
              </Button>
            </div>
          </div>
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
