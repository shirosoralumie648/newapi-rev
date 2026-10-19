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
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getUserGroups, getUserModels } from '../../api'
import { PlaygroundEmbeddingTool } from './playground-embedding-tool'
import { PlaygroundModerationTool } from './playground-moderation-tool'
import { PlaygroundRerankTool } from './playground-rerank-tool'

export function PlaygroundTools() {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [group, setGroup] = useState('')
  const [model, setModel] = useState('')

  const groupsQuery = useQuery({
    queryKey: ['playground-tool-groups', userId],
    queryFn: async () => requireServerSuccess(await getUserGroups()),
  })
  const modelsQuery = useQuery({
    queryKey: ['playground-tool-models', userId, group],
    queryFn: async () => requireServerSuccess(await getUserModels(group)),
    enabled: group !== '',
  })
  const groups = groupsQuery.data ?? []
  const models = modelsQuery.data ?? []

  useEffect(() => {
    if (group === '' && groups.length > 0) {
      setGroup(groups[0].value)
    }
  }, [group, groups])

  useEffect(() => {
    if (model === '' && models.length > 0) {
      setModel(models[0].value)
    }
  }, [model, models])

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <header className='border-b px-4 py-4 sm:px-6'>
        <h1 className='text-lg font-semibold'>{t('Model tools')}</h1>
        <p className='text-muted-foreground mt-1 max-w-3xl text-sm'>
          {t(
            'Test embedding, rerank, and moderation models through the same group, channel selection, and billing pipeline as the API.'
          )}
        </p>
        <div className='mt-4 flex flex-wrap items-end gap-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='playground-tool-group'>{t('Group')}</Label>
            <Select
              items={groups}
              onValueChange={(value) => {
                if (typeof value === 'string') setGroup(value)
              }}
              value={group || null}
            >
              <SelectTrigger
                className='w-44'
                id='playground-tool-group'
                size='sm'
              >
                <SelectValue placeholder={t('Select a group')} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='min-w-56 flex-1 space-y-1.5 sm:max-w-sm'>
            <Label htmlFor='playground-tool-model'>{t('Model')}</Label>
            <Input
              id='playground-tool-model'
              list='playground-tool-model-options'
              onChange={(event) => setModel(event.target.value)}
              placeholder={t('Enter a model name')}
              value={model}
            />
            <datalist id='playground-tool-model-options'>
              {models.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </datalist>
          </div>
        </div>
        {modelsQuery.isLoading ? (
          <p className='text-muted-foreground mt-2 text-xs'>
            {t('Loading models...')}
          </p>
        ) : null}
        {!modelsQuery.isLoading && models.length === 0 ? (
          <p className='text-muted-foreground mt-2 text-xs'>
            {t('No models are available for this group.')}
          </p>
        ) : null}
      </header>

      <div className='min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6'>
        <Tabs defaultValue='embeddings'>
          <TabsList>
            <TabsTrigger value='embeddings'>{t('Embeddings')}</TabsTrigger>
            <TabsTrigger value='rerank'>{t('Rerank')}</TabsTrigger>
            <TabsTrigger value='moderation'>{t('Moderation')}</TabsTrigger>
          </TabsList>
          <TabsContent keepMounted value='embeddings'>
            <PlaygroundEmbeddingTool
              group={group}
              model={model}
              userId={userId}
            />
          </TabsContent>
          <TabsContent keepMounted value='rerank'>
            <PlaygroundRerankTool group={group} model={model} userId={userId} />
          </TabsContent>
          <TabsContent keepMounted value='moderation'>
            <PlaygroundModerationTool
              group={group}
              model={model}
              userId={userId}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
