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
import type { TFunction } from 'i18next'

import { evalExprLocally } from '@/features/pricing/lib/tier-expr'
import { formatBillingCurrencyFromUSD } from '@/lib/currency'

const TOKENS_PER_MILLION = 1_000_000

// Capability identifiers come from the server; the labels are existing keys.
const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  vision: 'Vision',
  tools: 'Tools',
  reasoning: 'Reasoning',
  structured_output: 'Structured output',
}

/**
 * Read-only pricing fields of one model, mirrored from `GET /api/user/models`.
 * The shape stays structural so the estimator stays a pure function and can be
 * table-tested without the playground state types.
 */
export interface PlaygroundCostModel {
  quotaType?: number
  modelRatio?: number
  modelPrice?: number
  completionRatio?: number
  cacheRatio?: number | null
  billingMode?: string
  billingExpr?: string
}

export interface PlaygroundCostInput {
  model?: PlaygroundCostModel | null
  /** Estimated input tokens of the request; may include cached input. */
  promptTokens: number
  /** Expected output tokens; zero means input-only. */
  completionTokens?: number
  /** Cached input tokens, a subset of `promptTokens`. */
  cacheReadTokens?: number
  groupRatio?: number | string | null
  contextLength?: number
}

export type PlaygroundCostEstimate =
  | {
      status: 'estimated'
      billingUnit: 'token' | 'request'
      amountUSD: number
      promptTokens: number
      completionTokens: number
      cacheReadTokens: number
      groupRatio: number
      contextLength: number
      exceedsContext: boolean
    }
  | {
      status: 'no-price'
      reason: 'unconfigured' | 'expression'
      promptTokens: number
      completionTokens: number
      cacheReadTokens: number
      groupRatio: number
      contextLength: number
      exceedsContext: boolean
    }
  | {
      status: 'missing-cache-price'
      promptTokens: number
      completionTokens: number
      cacheReadTokens: number
      groupRatio: number
      contextLength: number
      exceedsContext: boolean
    }

/**
 * Unit price of one model for the selector: token prices per million tokens or
 * a fixed per-request price. `usage` marks prices that depend on task usage the
 * selector cannot know before a run; `unavailable` marks missing prices.
 */
export type PlaygroundModelPrice =
  | { kind: 'token'; inputUSD: number; outputUSD: number }
  | { kind: 'request'; requestUSD: number }
  | { kind: 'usage' }
  | { kind: 'unavailable' }

/** Non-numeric group ratios (such as `auto`) price at the base rate. */
export function normalizeGroupRatio(
  value: number | string | null | undefined
): number {
  const ratio = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
}

function normalizeTokens(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.trunc(value)
}

function normalizeCompletionRatio(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 1
}

function evaluateExpressionUSD(
  expression: string,
  promptTokens: number,
  completionTokens: number
): { amountUSD: number; billingUnit: 'token' | 'request' } | null {
  const result = evalExprLocally(expression, promptTokens, completionTokens, {
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheCreate1hTokens: 0,
    imageTokens: 0,
    imageCacheTokens: 0,
    imageOutputTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
  })
  if (result.error) {
    return null
  }
  // The evaluator returns v1 expression units; dividing by one million yields
  // USD for token prices and for `fixed()` request prices alike.
  return {
    amountUSD: result.cost / TOKENS_PER_MILLION,
    billingUnit: result.billingUnit === 'request' ? 'request' : 'token',
  }
}

/**
 * Unit price shown in the model selector. Token expressions are sampled at one
 * million tokens per direction, fixed request expressions use their fixed
 * price, and usage-dependent task expressions degrade to `usage`.
 */
export function describeModelPrice(
  model: PlaygroundCostModel | null | undefined,
  groupRatio?: number | string | null
): PlaygroundModelPrice {
  if (!model) {
    return { kind: 'unavailable' }
  }
  const ratio = normalizeGroupRatio(groupRatio)
  const expression = model.billingExpr?.trim() ?? ''
  if (model.billingMode === 'tiered_expr' && expression) {
    const flat = evaluateExpressionUSD(expression, 0, 0)
    if (!flat) {
      return { kind: 'usage' }
    }
    if (flat.billingUnit === 'request') {
      return { kind: 'request', requestUSD: flat.amountUSD * ratio }
    }
    const input = evaluateExpressionUSD(expression, TOKENS_PER_MILLION, 0)
    const output = evaluateExpressionUSD(expression, 0, TOKENS_PER_MILLION)
    if (
      !input ||
      !output ||
      input.billingUnit === 'request' ||
      output.billingUnit === 'request'
    ) {
      return { kind: 'usage' }
    }
    return {
      kind: 'token',
      inputUSD: input.amountUSD * ratio,
      outputUSD: output.amountUSD * ratio,
    }
  }
  if (model.quotaType === 1) {
    if (
      typeof model.modelPrice !== 'number' ||
      !Number.isFinite(model.modelPrice) ||
      model.modelPrice < 0
    ) {
      return { kind: 'unavailable' }
    }
    return { kind: 'request', requestUSD: model.modelPrice * ratio }
  }
  if (
    typeof model.modelRatio === 'number' &&
    Number.isFinite(model.modelRatio)
  ) {
    const inputUSD = model.modelRatio * 2 * ratio
    return {
      kind: 'token',
      inputUSD,
      outputUSD: inputUSD * normalizeCompletionRatio(model.completionRatio),
    }
  }
  return { kind: 'unavailable' }
}

/**
 * Estimate the cost of one send from the model's read-only pricing fields.
 *
 * The estimate intentionally mirrors the relay's pricing rules without writing
 * to any billing state: legacy ratio models price input, cached input, and
 * output at `ratio * 2` USD per million tokens; request models price each call
 * at `model_price`; tiered expressions are evaluated locally. The returned
 * amount is always an approximation — group ratios, cache hits, reasoning
 * tokens, and upstream usage drive the amount actually settled in the
 * consumption logs.
 */
export function estimatePlaygroundCost(
  input: PlaygroundCostInput
): PlaygroundCostEstimate {
  const promptTokens = normalizeTokens(input.promptTokens)
  const completionTokens = normalizeTokens(input.completionTokens)
  const cacheReadTokens = Math.min(
    normalizeTokens(input.cacheReadTokens),
    promptTokens
  )
  const groupRatio = normalizeGroupRatio(input.groupRatio)
  const contextLength = normalizeTokens(input.contextLength)
  const exceedsContext = contextLength > 0 && promptTokens > contextLength
  const base = {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    groupRatio,
    contextLength,
    exceedsContext,
  }

  const model = input.model
  if (!model) {
    return { status: 'no-price', reason: 'unconfigured', ...base }
  }

  const expression = model.billingExpr?.trim() ?? ''
  if (model.billingMode === 'tiered_expr' && expression) {
    const evaluated = evaluateExpressionUSD(
      expression,
      promptTokens,
      completionTokens
    )
    if (!evaluated) {
      return { status: 'no-price', reason: 'expression', ...base }
    }
    return {
      status: 'estimated',
      billingUnit: evaluated.billingUnit,
      amountUSD: evaluated.amountUSD * groupRatio,
      ...base,
    }
  }

  if (model.quotaType === 1) {
    if (
      typeof model.modelPrice !== 'number' ||
      !Number.isFinite(model.modelPrice) ||
      model.modelPrice < 0
    ) {
      return { status: 'no-price', reason: 'unconfigured', ...base }
    }
    return {
      status: 'estimated',
      billingUnit: 'request',
      amountUSD: model.modelPrice * groupRatio,
      ...base,
    }
  }

  if (
    typeof model.modelRatio !== 'number' ||
    !Number.isFinite(model.modelRatio)
  ) {
    return { status: 'no-price', reason: 'unconfigured', ...base }
  }
  if (cacheReadTokens > 0) {
    const cacheRatio =
      typeof model.cacheRatio === 'number' && Number.isFinite(model.cacheRatio)
        ? model.cacheRatio
        : null
    if (cacheRatio === null) {
      // Cached input has its own rate; without it the amount would be invented.
      return { status: 'missing-cache-price', ...base }
    }
  }
  const cacheRatio =
    typeof model.cacheRatio === 'number' && Number.isFinite(model.cacheRatio)
      ? model.cacheRatio
      : 0
  const millionUSD = (model.modelRatio * 2 * groupRatio) / TOKENS_PER_MILLION
  const cacheUSD = cacheReadTokens * millionUSD * cacheRatio
  const inputUSD = (promptTokens - cacheReadTokens) * millionUSD
  const outputUSD =
    completionTokens *
    millionUSD *
    normalizeCompletionRatio(model.completionRatio)
  return {
    status: 'estimated',
    billingUnit: 'token',
    amountUSD: inputUSD + cacheUSD + outputUSD,
    ...base,
  }
}

/**
 * Translated capability tags of one model for the selector, in the server's
 * stable order. Unknown identifiers are ignored instead of shown raw.
 */
export function describeModelCapabilities(
  capabilities: string[] | undefined,
  t: TFunction
): string[] {
  if (!capabilities?.length) {
    return []
  }
  const labels: string[] = []
  for (const capability of capabilities) {
    const key = CAPABILITY_LABEL_KEYS[capability]
    if (key) {
      labels.push(t(key))
    }
  }
  return labels
}

/**
 * One-line price summary of a model for the selector. Usage-dependent task
 * prices and missing prices degrade to translated text instead of an amount.
 */
export function formatModelPriceLabel(
  price: PlaygroundModelPrice,
  t: TFunction
): string {
  switch (price.kind) {
    case 'token':
      return `${formatBillingCurrencyFromUSD(price.inputUSD)} / ${formatBillingCurrencyFromUSD(price.outputUSD)} / ${t('1M token')}`
    case 'request':
      return `${formatBillingCurrencyFromUSD(price.requestUSD)} ${t('per request')}`
    case 'usage':
      return t('Priced by usage')
    default:
      return t('No price configured')
  }
}
