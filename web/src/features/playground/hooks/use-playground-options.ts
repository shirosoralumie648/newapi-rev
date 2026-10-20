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
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { getPlaygroundModelCatalog, getUserGroups, getUserModels } from '../api'
import {
  EMPTY_PLAYGROUND_MODEL_CATALOG,
  getGroupFallback,
  getModelFallback,
  getOptionLoadErrorMessage,
  isChatModelOption,
  mergePlaygroundModelCatalog,
  shouldClearModelForGroup,
} from '../lib'
import type { GroupOption, ModelOption, PlaygroundConfig } from '../types'

type UsePlaygroundOptionsParams = {
  currentGroup: string
  currentModel: string
  setGroups: (groups: GroupOption[]) => void
  setModels: (models: ModelOption[]) => void
  updateConfig: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
}

export function usePlaygroundOptions({
  currentGroup,
  currentModel,
  setGroups,
  setModels,
  updateConfig,
}: UsePlaygroundOptionsParams) {
  const { t } = useTranslation()
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)

  const {
    data: modelsData,
    error: modelsError,
    isError: isModelsError,
    isLoading: isLoadingModels,
  } = useQuery({
    queryKey: ['playground-models', userId, currentGroup],
    queryFn: async () =>
      requireServerSuccess(await getUserModels(currentGroup)),
    enabled: currentGroup !== '',
  })

  const {
    data: groupsData,
    error: groupsError,
    isError: isGroupsError,
  } = useQuery({
    queryKey: ['playground-groups', userId],
    queryFn: async () => requireServerSuccess(await getUserGroups()),
  })

  // The catalog only decorates the raw model list. A failed read must never
  // block the Playground, so an unavailable catalog degrades to the flat list.
  const { data: catalogData } = useQuery({
    queryKey: ['playground-model-catalog', userId],
    queryFn: async () => {
      try {
        return await getPlaygroundModelCatalog()
      } catch {
        return EMPTY_PLAYGROUND_MODEL_CATALOG
      }
    },
    staleTime: 5 * 60 * 1000,
  })

  const effectiveModels = useMemo(
    () => mergePlaygroundModelCatalog(modelsData ?? [], catalogData),
    [modelsData, catalogData]
  )

  useEffect(() => {
    if (!isModelsError) return

    handleServerError(
      modelsError,
      getOptionLoadErrorMessage(
        modelsError,
        t('Failed to load playground models')
      )
    )
  }, [isModelsError, modelsError, t])

  useEffect(() => {
    if (!isGroupsError) return

    handleServerError(
      groupsError,
      getOptionLoadErrorMessage(
        groupsError,
        t('Failed to load playground groups')
      )
    )
  }, [isGroupsError, groupsError, t])

  useEffect(() => {
    if (!modelsData) return

    setModels(effectiveModels)
    const chatModels = effectiveModels.filter(isChatModelOption)
    const fallback = getModelFallback(chatModels, currentModel)

    if (fallback) {
      updateConfig('model', fallback)
      return
    }

    if (shouldClearModelForGroup(chatModels, currentModel)) {
      updateConfig('model', '')
    }
  }, [modelsData, effectiveModels, currentModel, setModels, updateConfig])

  useEffect(() => {
    if (!groupsData) return

    setGroups(groupsData)
    const fallback = getGroupFallback(groupsData, currentGroup)

    if (fallback) {
      updateConfig('group', fallback)
    }
  }, [groupsData, currentGroup, setGroups, updateConfig])

  return {
    isLoadingModels,
  }
}
