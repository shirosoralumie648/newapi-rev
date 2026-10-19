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

import {
  PLAYGROUND_GENERATION_BATCH_MESSAGES,
  PLAYGROUND_GENERATION_SEED_MAX,
} from '@/features/playground/constants'

import {
  buildGenerationBatchPlan,
  clampGenerationVariationCount,
  collectGenerationSchemaOptions,
  emptyGenerationSchemaOptions,
  generationLimits,
  generationOptionSets,
  generationSeedGrid,
  mergeGenerationSchemaOptions,
} from '../generation-batch'

const imageLimits = {
  'img-a': {
    sizes: ['1024x1024'],
    qualities: ['high'],
  },
}

function buildVariationsPlan(count: number, baseSeed = 100) {
  return buildGenerationBatchPlan({
    mode: 'variations',
    kind: 'image',
    prompt: '  a red fox  ',
    group: 'default',
    models: [' img-a ', 'img-a'],
    variationCount: count,
    seedMode: 'increment',
    baseSeed,
    size: '1792x1024',
    quality: 'high',
    limits: imageLimits,
  })
}

describe('generation seed grid', () => {
  test('increments from the base seed and wraps inside the accepted range', () => {
    expect(
      generationSeedGrid({
        count: 4,
        mode: 'increment',
        baseSeed: PLAYGROUND_GENERATION_SEED_MAX - 1,
      })
    ).toEqual([
      PLAYGROUND_GENERATION_SEED_MAX - 1,
      PLAYGROUND_GENERATION_SEED_MAX,
      1,
      2,
    ])
  })

  test('random mode keeps every variation distinct even for a degenerate source', () => {
    const seeds = generationSeedGrid({
      count: 4,
      mode: 'random',
      baseSeed: 7,
      randomSeed: () => 7,
    })
    expect(seeds).toEqual([7, 8, 9, 10])
    expect(new Set(seeds).size).toBe(seeds.length)
  })

  test('bounds the grid to the interface and relay image count', () => {
    expect(clampGenerationVariationCount(0)).toBe(1)
    expect(clampGenerationVariationCount(9)).toBe(8)
    expect(clampGenerationVariationCount(128)).toBe(8)
    expect(clampGenerationVariationCount(Number.NaN)).toBe(1)
  })
})

describe('generation batch plan', () => {
  test('variations send one request per incremented seed with mapped parameters', () => {
    const plan = buildVariationsPlan(3)

    expect(plan.errorKey).toBeUndefined()
    expect(plan.blocked).toEqual([])
    expect(plan.prompt).toBe('a red fox')
    expect(plan.requests.map((request) => request.seed)).toEqual([
      100, 101, 102,
    ])
    expect(plan.requests.every((request) => request.count === 1)).toBe(true)
    expect(plan.requests.every((request) => request.model === 'img-a')).toBe(
      true
    )
    expect(plan.requests[0]).toMatchObject({
      size: '1024x1024',
      quality: 'high',
    })
    expect(plan.requests[0]?.adjustments[0]).toMatchObject({
      field: 'size',
      from: '1792x1024',
      to: '1024x1024',
    })
  })

  test('comparison shares one seed across two models and maps each model separately', () => {
    const plan = buildGenerationBatchPlan({
      mode: 'compare',
      kind: 'image',
      prompt: 'a lighthouse',
      group: 'default',
      models: ['img-a', 'img-b'],
      baseSeed: 42,
      size: '1792x1024',
      limits: {
        'img-a': { sizes: ['1024x1024'] },
        'img-b': { sizes: ['1792x1024'] },
      },
    })

    expect(plan.requests.map((request) => request.model)).toEqual([
      'img-a',
      'img-b',
    ])
    expect(plan.requests.map((request) => request.seed)).toEqual([42, 42])
    expect(plan.requests[0]).toMatchObject({ size: '1024x1024' })
    expect(plan.requests[1]).toMatchObject({ size: '1792x1024' })
    expect(plan.requests[0]?.adjustments).toHaveLength(1)
    expect(plan.requests[1]?.adjustments).toHaveLength(0)
  })

  test('comparison enforces the two to four model selection', () => {
    expect(
      buildGenerationBatchPlan({
        mode: 'compare',
        kind: 'image',
        prompt: 'a lighthouse',
        group: 'default',
        models: ['img-a'],
      }).errorKey
    ).toBe(PLAYGROUND_GENERATION_BATCH_MESSAGES.COMPARE_SELECTION)

    expect(
      buildGenerationBatchPlan({
        mode: 'compare',
        kind: 'image',
        prompt: 'a lighthouse',
        group: 'default',
        models: ['a', 'b', 'c', 'd', 'e'],
      }).errorKey
    ).toBe(PLAYGROUND_GENERATION_BATCH_MESSAGES.COMPARE_SELECTION)
  })

  test('an explicit capability gap blocks the model instead of silently skipping it', () => {
    const plan = buildGenerationBatchPlan({
      mode: 'variations',
      kind: 'image',
      prompt: 'a red fox',
      group: 'default',
      models: ['text-only'],
      variationCount: 2,
      baseSeed: 1,
      limits: { 'text-only': { image: false } },
    })

    expect(plan.requests).toEqual([])
    expect(plan.blocked).toEqual([
      {
        model: 'text-only',
        messageKey: PLAYGROUND_GENERATION_BATCH_MESSAGES.IMAGE_UNSUPPORTED,
      },
    ])
  })

  test('video comparison clamps each model duration and reports the mapping', () => {
    const plan = buildGenerationBatchPlan({
      mode: 'compare',
      kind: 'video',
      prompt: 'a sailing ship',
      group: 'default',
      models: ['video-a', 'video-b'],
      baseSeed: 9,
      duration: 10,
      limits: {
        'video-a': { durations: [5] },
        'video-b': { durations: [8] },
      },
    })

    expect(plan.requests.map((request) => request.duration)).toEqual([5, 8])
    expect(plan.requests.map((request) => request.seed)).toEqual([9, 9])
    expect(
      plan.requests.every((request) => request.adjustments.length === 1)
    ).toBe(true)
  })
})

describe('generation capability options', () => {
  test('collects schema enums and treats an empty enum as unspecified', () => {
    const options = collectGenerationSchemaOptions(
      emptyGenerationSchemaOptions(),
      {
        size: { enum: ['1024x1024', '16:9'] },
        quality: { enum: ['high'] },
        duration: { enum: ['5', '10', '9999'] },
      },
      { image: true, video: true }
    )

    expect(options.imageSizes).toEqual(['1024x1024'])
    expect(options.videoSizes).toEqual(['1024x1024', '16:9'])
    expect(options.qualities).toEqual(['high'])
    expect(options.durations).toEqual([5, 10])
    expect(
      generationLimits('video', emptyGenerationSchemaOptions(), null)
    ).toEqual({
      image: true,
      video: true,
    })
  })

  test('merges compared model options and offers the union in the form', () => {
    const first = collectGenerationSchemaOptions(
      emptyGenerationSchemaOptions(),
      { size: { enum: ['1024x1024'] } },
      { image: true, video: false }
    )
    const second = collectGenerationSchemaOptions(
      emptyGenerationSchemaOptions(),
      { size: { enum: ['1280x720'] } },
      { image: true, video: false }
    )
    const merged = mergeGenerationSchemaOptions(first, second)
    const sets = generationOptionSets('image', merged)

    expect(sets.sizes).toContain('1024x1024')
    expect(sets.sizes).toContain('1280x720')
    expect(sets.sizes).toContain('1792x1024')
  })
})
