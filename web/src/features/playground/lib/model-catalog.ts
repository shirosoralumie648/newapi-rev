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
import type {
  ModelOption,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundModelCatalog,
  PlaygroundModelCatalogDefaults,
} from '../types'
import { normalizeReasoningEffort } from './parameters/playground-reasoning'

export const EMPTY_PLAYGROUND_MODEL_CATALOG: PlaygroundModelCatalog = {
  groups: [],
  models: [],
}

/**
 * Applies the administrator catalog to the raw model list. Only models the
 * account can currently use survive, so a renamed or removed model simply
 * returns to its raw name in the uncategorized list instead of becoming a dead
 * entry. Curated catalog order wins; models missing from the catalog keep the
 * server order after it.
 */
export function mergePlaygroundModelCatalog(
  models: ModelOption[],
  catalog: PlaygroundModelCatalog | undefined
): ModelOption[] {
  if (
    !catalog ||
    (catalog.groups.length === 0 && catalog.models.length === 0)
  ) {
    return models
  }

  const available = new Map(models.map((model) => [model.value, model]))
  const groupById = new Map(catalog.groups.map((group) => [group.id, group]))
  const entriesByGroup = new Map<string, string[]>()
  const ungrouped: string[] = []
  const handled = new Set<string>()

  for (const entry of catalog.models) {
    if (entry.hidden) {
      handled.add(entry.model)
      continue
    }
    if (!available.has(entry.model)) continue
    handled.add(entry.model)
    const group = entry.group ? groupById.get(entry.group) : undefined
    if (!group) {
      ungrouped.push(entry.model)
      continue
    }
    const names = entriesByGroup.get(group.id) ?? []
    names.push(entry.model)
    entriesByGroup.set(group.id, names)
  }

  const entries = new Map(catalog.models.map((entry) => [entry.model, entry]))
  const result: ModelOption[] = []
  const append = (modelName: string, categoryId?: string) => {
    const model = available.get(modelName)
    const entry = entries.get(modelName)
    if (!model || !entry) return

    const group = categoryId ? groupById.get(categoryId) : undefined
    const displayName = entry.displayName?.trim()
    const description = entry.description?.trim()
    const icon = entry.icon?.trim()
    result.push({
      ...model,
      label: displayName || model.label,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(group
        ? {
            category: group.label,
            ...(group.description
              ? { categoryDescription: group.description }
              : {}),
          }
        : {}),
      ...(entry.capabilities?.length
        ? { capabilities: entry.capabilities }
        : {}),
      ...(entry.defaults ? { catalogDefaults: entry.defaults } : {}),
      ...(entry.limits?.contextLength !== undefined
        ? { contextLength: entry.limits.contextLength }
        : {}),
    })
  }

  for (const group of catalog.groups) {
    for (const modelName of entriesByGroup.get(group.id) ?? []) {
      append(modelName, group.id)
    }
  }
  for (const modelName of ungrouped) {
    append(modelName)
  }
  for (const model of models) {
    if (!handled.has(model.value)) result.push(model)
  }
  return result
}

export interface PlaygroundModelCatalogDefaultConfig {
  config: Partial<PlaygroundConfig>
  parameterEnabled: Partial<ParameterEnabled>
}

/**
 * Turns one catalog entry's defaults into conversation values. An explicit 0
 * stays a value (temperature 0 is a valid starting point), and every supplied
 * parameter is switched on so the composer sends it. Returns null when the
 * entry contributes nothing.
 */
export function modelCatalogDefaultConfig(
  defaults: PlaygroundModelCatalogDefaults | undefined
): PlaygroundModelCatalogDefaultConfig | null {
  if (!defaults) return null

  const config: Partial<PlaygroundConfig> = {}
  const parameterEnabled: Partial<ParameterEnabled> = {}
  if (defaults.temperature !== undefined) {
    config.temperature = defaults.temperature
    parameterEnabled.temperature = true
  }
  if (defaults.topP !== undefined) {
    config.top_p = defaults.topP
    parameterEnabled.top_p = true
  }
  if (defaults.maxTokens !== undefined) {
    config.max_tokens = defaults.maxTokens
    parameterEnabled.max_tokens = true
  }
  if (defaults.frequencyPenalty !== undefined) {
    config.frequency_penalty = defaults.frequencyPenalty
    parameterEnabled.frequency_penalty = true
  }
  if (defaults.presencePenalty !== undefined) {
    config.presence_penalty = defaults.presencePenalty
    parameterEnabled.presence_penalty = true
  }
  if (defaults.seed !== undefined) {
    config.seed = defaults.seed
    parameterEnabled.seed = true
  }
  if (defaults.reasoningEffort !== undefined) {
    const effort = normalizeReasoningEffort(defaults.reasoningEffort)
    if (effort) {
      config.reasoning_effort = effort
      parameterEnabled.reasoning_effort = true
    }
  }

  if (
    Object.keys(config).length === 0 &&
    Object.keys(parameterEnabled).length === 0
  ) {
    return null
  }
  return { config, parameterEnabled }
}
