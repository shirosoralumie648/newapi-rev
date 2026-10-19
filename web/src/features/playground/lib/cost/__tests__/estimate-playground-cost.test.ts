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
import { expect, test } from 'vitest'

import {
  describeModelPrice,
  estimatePlaygroundCost,
  normalizeGroupRatio,
} from '../estimate-playground-cost'

test('prices a ratio model by uncached input, cached input and output with the group ratio', () => {
  const estimate = estimatePlaygroundCost({
    model: { modelRatio: 1.5, completionRatio: 2, cacheRatio: 0.25 },
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    cacheReadTokens: 200_000,
    groupRatio: 1.2,
  })

  expect(estimate.status).toBe('estimated')
  if (estimate.status !== 'estimated') return
  const perTokenUSD = (1.5 * 2 * 1.2) / 1_000_000
  expect(estimate.billingUnit).toBe('token')
  expect(estimate.amountUSD).toBeCloseTo(
    800_000 * perTokenUSD +
      200_000 * perTokenUSD * 0.25 +
      500_000 * perTokenUSD * 2,
    10
  )
})

test('prices a per-request model at its request price multiplied by the group ratio', () => {
  const estimate = estimatePlaygroundCost({
    model: { quotaType: 1, modelPrice: 0.04 },
    promptTokens: 10,
    groupRatio: 2,
  })

  expect(estimate.status).toBe('estimated')
  if (estimate.status !== 'estimated') return
  expect(estimate.billingUnit).toBe('request')
  expect(estimate.amountUSD).toBeCloseTo(0.08, 10)
})

test('prices an expression model from its per-million-token expression', () => {
  const estimate = estimatePlaygroundCost({
    model: {
      billingMode: 'tiered_expr',
      billingExpr: 'tier("standard", p * 3 + c * 15)',
    },
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  })

  expect(estimate.status).toBe('estimated')
  if (estimate.status !== 'estimated') return
  expect(estimate.billingUnit).toBe('token')
  expect(estimate.amountUSD).toBeCloseTo(18, 10)
})

test('flags every estimate whose input exceeds the context window', () => {
  const estimate = estimatePlaygroundCost({
    model: { modelRatio: 1 },
    promptTokens: 128_001,
    contextLength: 128_000,
  })
  expect(estimate.exceedsContext).toBe(true)

  const withinContext = estimatePlaygroundCost({
    model: { modelRatio: 1 },
    promptTokens: 128_000,
    contextLength: 128_000,
  })
  expect(withinContext.exceedsContext).toBe(false)
})

test('degrades to no-price when the model has no usable price', () => {
  expect(
    estimatePlaygroundCost({ model: null, promptTokens: 10 })
  ).toMatchObject({ status: 'no-price', reason: 'unconfigured' })
  expect(estimatePlaygroundCost({ model: {}, promptTokens: 10 })).toMatchObject(
    { status: 'no-price', reason: 'unconfigured' }
  )
  expect(
    estimatePlaygroundCost({
      model: {
        billingMode: 'tiered_expr',
        billingExpr: 'tier("x", unknown * 3)',
      },
      promptTokens: 10,
    })
  ).toMatchObject({ status: 'no-price', reason: 'expression' })
})

test('degrades to missing-cache-price when cached input has no cache ratio', () => {
  const estimate = estimatePlaygroundCost({
    model: { modelRatio: 1 },
    promptTokens: 1_000,
    cacheReadTokens: 400,
  })

  expect(estimate.status).toBe('missing-cache-price')
  expect('amountUSD' in estimate).toBe(false)
})

test('normalizes non-numeric and non-positive group ratios to the base rate', () => {
  expect(normalizeGroupRatio(undefined)).toBe(1)
  expect(normalizeGroupRatio('auto')).toBe(1)
  expect(normalizeGroupRatio(0)).toBe(1)
  expect(normalizeGroupRatio(-2)).toBe(1)
  expect(normalizeGroupRatio('1.5')).toBe(1.5)
  expect(normalizeGroupRatio(1.5)).toBe(1.5)
})

test('describes token, request, usage-priced and missing prices for the selector', () => {
  const tokenPrice = describeModelPrice(
    { modelRatio: 1.5, completionRatio: 2 },
    1
  )
  expect(tokenPrice.kind).toBe('token')
  if (tokenPrice.kind === 'token') {
    expect(tokenPrice.inputUSD).toBeCloseTo(3, 10)
    expect(tokenPrice.outputUSD).toBeCloseTo(6, 10)
  }

  const requestPrice = describeModelPrice({ quotaType: 1, modelPrice: 0.04 }, 2)
  expect(requestPrice.kind).toBe('request')
  if (requestPrice.kind === 'request') {
    expect(requestPrice.requestUSD).toBeCloseTo(0.08, 10)
  }

  const expressionPrice = describeModelPrice({
    billingMode: 'tiered_expr',
    billingExpr: 'tier("request", fixed(0.01))',
  })
  expect(expressionPrice.kind).toBe('request')
  if (expressionPrice.kind === 'request') {
    expect(expressionPrice.requestUSD).toBeCloseTo(0.01, 10)
  }

  expect(
    describeModelPrice({
      billingMode: 'tiered_expr',
      billingExpr: 'tier("x", unknown * 3)',
    })
  ).toEqual({ kind: 'usage' })
  expect(describeModelPrice({})).toEqual({ kind: 'unavailable' })
  expect(describeModelPrice(null)).toEqual({ kind: 'unavailable' })
})
