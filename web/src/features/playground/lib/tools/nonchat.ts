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
  PlaygroundModerationItem,
  PlaygroundRerankItem,
} from '../../tools-api'

/** Why a textarea value does not fit the server-side request bounds. */
export type NonChatTextIssue = 'empty' | 'too_many' | 'too_long'

export interface NonChatTextValidation {
  values: string[]
  issue?: NonChatTextIssue
}

const MAX_SIMILARITY_VECTORS = 8

/** How many vectors the similarity table renders before truncating. */
export const NON_CHAT_MAX_SIMILARITY_VECTORS = MAX_SIMILARITY_VECTORS

/**
 * Splits a one-item-per-line textarea into trimmed, non-empty lines and checks
 * it against the same count and length limits the backend enforces.
 */
export function parseNonChatLines(
  value: string,
  maxItems: number,
  maxChars: number
): NonChatTextValidation {
  const values = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (values.length === 0) {
    return { values, issue: 'empty' }
  }
  if (values.length > maxItems) {
    return { values, issue: 'too_many' }
  }
  if (values.some((item) => item.length > maxChars)) {
    return { values, issue: 'too_long' }
  }
  return { values }
}

/** Cosine similarity of two vectors, or null when dimensions differ. */
export function cosineSimilarity(
  left: number[],
  right: number[]
): number | null {
  if (left.length !== right.length || left.length === 0) return null
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return Math.min(1, Math.max(-1, dot / Math.sqrt(leftNorm * rightNorm)))
}

export interface NonChatSimilarityPair {
  left: number
  right: number
  value: number | null
}

/**
 * Upper-triangle similarity pairs for the first few vectors. Embedding
 * responses can hold dozens of vectors, so the matrix stays bounded instead of
 * rendering thousands of cells.
 */
export function pairwiseCosineSimilarities(
  vectors: number[][],
  maxVectors = MAX_SIMILARITY_VECTORS
): NonChatSimilarityPair[] {
  const limit = Math.min(vectors.length, maxVectors)
  const pairs: NonChatSimilarityPair[] = []
  for (let left = 0; left < limit; left += 1) {
    for (let right = left + 1; right < limit; right += 1) {
      pairs.push({
        left,
        right,
        value: cosineSimilarity(vectors[left], vectors[right]),
      })
    }
  }
  return pairs
}

/**
 * Orders rerank results the way readers expect: highest score first, then the
 * provider's original document index so equal scores stay deterministic.
 */
export function sortRerankItems(
  items: PlaygroundRerankItem[]
): PlaygroundRerankItem[] {
  return [...items].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.index - right.index
  })
}

export interface ModerationCategoryRow {
  name: string
  score: number
  flagged: boolean
  highlighted: boolean
}

/**
 * Builds the category rows the moderation panel renders. The threshold only
 * controls local highlighting; the provider's `flagged` decision remains the
 * authoritative result.
 */
export function moderationCategoryRows(
  item: PlaygroundModerationItem,
  threshold: number
): ModerationCategoryRow[] {
  const names = new Set([
    ...Object.keys(item.categories),
    ...Object.keys(item.categoryScores),
  ])
  return [...names]
    .map((name) => {
      const score = item.categoryScores[name] ?? 0
      return {
        name,
        score,
        flagged: item.categories[name] === true,
        highlighted: score >= threshold,
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.name.localeCompare(right.name)
    })
}

/** Fixed-point score display; `@/lib/format` rounds to two decimals only. */
export function formatNonChatScore(
  value: number | null | undefined,
  locale?: Intl.LocalesArgument
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-'
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)
}
