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
import { describe, expect, test } from 'vitest'

import type { ModelOption, PlaygroundModelCatalog } from '../../types'
import {
  mergePlaygroundModelCatalog,
  modelCatalogDefaultConfig,
} from '../model-catalog'

const rawModels: ModelOption[] = [
  {
    label: 'gpt-4o',
    value: 'gpt-4o',
    description: 'Server description',
    capabilities: ['vision'],
    contextLength: 8000,
  },
  { label: 'fast-model', value: 'fast-model' },
  { label: 'hidden-model', value: 'hidden-model' },
  { label: 'raw-model', value: 'raw-model' },
]

const catalog: PlaygroundModelCatalog = {
  groups: [
    { id: 'recommended', label: 'Recommended', description: 'Everyday use' },
    { id: 'fast', label: 'Fast' },
  ],
  models: [
    {
      model: 'gpt-4o',
      displayName: 'GPT-4o Display',
      description: 'Curated description',
      icon: '✨',
      group: 'recommended',
      capabilities: ['tools'],
      defaults: { temperature: 0, topP: 1, maxTokens: 2048 },
      limits: { contextLength: 128000, maxOutputTokens: 16384 },
    },
    {
      model: 'fast-model',
      displayName: 'Fast display',
      group: 'fast',
    },
    { model: 'hidden-model', hidden: true },
    // The catalog kept an entry for a model that was renamed upstream.
    { model: 'old-name', displayName: 'Old name' },
  ],
}

describe('mergePlaygroundModelCatalog', () => {
  test('applies display metadata, grouping and limits in catalog order', () => {
    const merged = mergePlaygroundModelCatalog(rawModels, catalog)

    expect(merged.map((model) => model.value)).toEqual([
      'gpt-4o',
      'fast-model',
      'raw-model',
    ])
    expect(merged[0]).toMatchObject({
      label: 'GPT-4o Display',
      description: 'Curated description',
      icon: '✨',
      category: 'Recommended',
      categoryDescription: 'Everyday use',
      capabilities: ['tools'],
      contextLength: 128000,
      maxOutputTokens: 16384,
      catalogDefaults: { temperature: 0, topP: 1, maxTokens: 2048 },
    })
    expect(merged[1]).toMatchObject({
      label: 'Fast display',
      category: 'Fast',
    })
    expect(merged[2]).toEqual(rawModels[3])
  })

  test('hides withdrawn models and falls back to raw names after rename', () => {
    const renamed = mergePlaygroundModelCatalog(
      [{ label: 'renamed-upstream', value: 'renamed-upstream' }],
      catalog
    )

    expect(renamed).toEqual([
      { label: 'renamed-upstream', value: 'renamed-upstream' },
    ])
    expect(
      mergePlaygroundModelCatalog(rawModels, catalog).some(
        (model) => model.value === 'hidden-model'
      )
    ).toBe(false)
  })

  test('an absent catalog leaves the raw model list untouched', () => {
    expect(mergePlaygroundModelCatalog(rawModels, undefined)).toBe(rawModels)
    expect(
      mergePlaygroundModelCatalog(rawModels, { groups: [], models: [] })
    ).toBe(rawModels)
  })
})

describe('modelCatalogDefaultConfig', () => {
  test('keeps explicit zero values and switches supplied parameters on', () => {
    expect(
      modelCatalogDefaultConfig({
        temperature: 0,
        topP: 0,
        maxTokens: 1024,
        frequencyPenalty: 0,
        presencePenalty: 1,
        seed: 0,
        reasoningEffort: 'HIGH',
      })
    ).toEqual({
      config: {
        temperature: 0,
        top_p: 0,
        max_tokens: 1024,
        frequency_penalty: 0,
        presence_penalty: 1,
        seed: 0,
        reasoning_effort: 'high',
      },
      parameterEnabled: {
        temperature: true,
        top_p: true,
        max_tokens: true,
        frequency_penalty: true,
        presence_penalty: true,
        seed: true,
        reasoning_effort: true,
      },
    })
  })

  test('an empty or missing default contributes nothing', () => {
    expect(modelCatalogDefaultConfig(undefined)).toBeNull()
    expect(modelCatalogDefaultConfig({})).toBeNull()
    expect(modelCatalogDefaultConfig({ reasoningEffort: 'unknown' })).toBeNull()
  })
})
