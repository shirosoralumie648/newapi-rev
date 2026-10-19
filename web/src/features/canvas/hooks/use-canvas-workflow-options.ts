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
import { useEffect, useMemo, useState } from 'react'

import { getUserGroups, getUserModels } from '@/features/playground/api'
import { DEFAULT_GROUP } from '@/features/playground/constants'
import { getGroupFallback } from '@/features/playground/lib'
import type { GroupOption, ModelOption } from '@/features/playground/types'
import { usePricingData } from '@/features/pricing/hooks/use-pricing-data'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import type { CanvasWorkflowModelCapability } from '../lib/canvas-workflow'

/**
 * Group and model options of a canvas workflow run. The queries reuse the
 * Playground workspace query keys so both views share one cache entry, and the
 * server remains the authority on which models the account may call.
 */
export function useCanvasWorkflowOptions() {
  const userId = useAuthStore((state) => state.auth.user?.id ?? null)
  const [group, setGroup] = useState<string>(DEFAULT_GROUP)

  const groupsQuery = useQuery({
    queryKey: ['playground-groups', userId],
    queryFn: async () => requireServerSuccess(await getUserGroups()),
  })

  const modelsQuery = useQuery({
    queryKey: ['playground-models', userId, group],
    queryFn: async () => requireServerSuccess(await getUserModels(group)),
    enabled: group !== '',
  })

  // `/api/pricing` is the public catalog of model endpoints and task usage
  // schemas. It can be disabled for a deployment, so an empty map means
  // "capability unknown" and the panel leaves every control enabled.
  const pricing = usePricingData(userId !== null)
  const modelCapabilities = useMemo(() => {
    const capabilities: Record<string, CanvasWorkflowModelCapability> = {}
    for (const model of pricing.models) {
      const usageFields = new Set(Object.keys(model.billing_usage_schema ?? {}))
      // Enum values of every usage field a task plugin can report, merged
      // across the model's plugin variants: these are the exact sizes,
      // qualities and durations a batch may send to this model.
      const enumValues = new Map<string, Set<string>>()
      const schemas = [
        model.billing_usage_schema,
        ...(model.billing_plugin_variants ?? []).map(
          (variant) => variant.billing_usage_schema
        ),
      ]
      for (const schema of schemas) {
        for (const [field, definition] of Object.entries(schema ?? {})) {
          for (const value of definition?.enum ?? []) {
            if (!value) continue
            const values = enumValues.get(field) ?? new Set<string>()
            values.add(value)
            enumValues.set(field, values)
          }
        }
        for (const field of Object.keys(schema ?? {})) {
          usageFields.add(field)
        }
      }
      const usageSchema: Record<string, { enum: string[] }> = {}
      for (const [field, values] of enumValues) {
        usageSchema[field] = { enum: [...values] }
      }
      capabilities[model.model_name] = {
        endpointTypes: model.supported_endpoint_types ?? [],
        usageFields: [...usageFields],
        usageSchema,
        ...(model.image_tools
          ? {
              imageTools: {
                edit: model.image_tools.edit === true,
                outpaint: model.image_tools.outpaint === true,
                backgroundRemoval:
                  model.image_tools.background_removal === true,
                styleReference: model.image_tools.style_reference === true,
              },
            }
          : {}),
      }
    }
    return capabilities
  }, [pricing.models])

  useEffect(() => {
    const groups = groupsQuery.data
    if (!groups) return
    const fallback = getGroupFallback(groups, group)
    if (fallback) setGroup(fallback)
  }, [groupsQuery.data, group])

  return {
    group,
    setGroup,
    groups: (groupsQuery.data ?? []) as GroupOption[],
    models: (modelsQuery.data ?? []) as ModelOption[],
    modelCapabilities,
  }
}
