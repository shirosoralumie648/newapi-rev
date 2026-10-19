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
  KnowledgeStaleDocument,
  MessageKnowledgeResult,
} from '../../types'

/** Hits requested from each bound base before the merged list is capped. */
export const KNOWLEDGE_RETRIEVAL_TOP_K = 6
/** Largest merged citation list; mirrors the server snapshot bound. */
export const KNOWLEDGE_RETRIEVAL_MAX_RESULTS = 12
/** Character budget of the merged source text; mirrors the server bound. */
export const KNOWLEDGE_RETRIEVAL_CHAR_BUDGET = 12_000

export interface KnowledgeSearchGroup {
  hits: MessageKnowledgeResult[]
  staleDocuments: KnowledgeStaleDocument[]
}

/**
 * Merge the per-base search responses into the ordered citation list one turn
 * injects. Ordering is score descending with filename, chunk index and chunk id
 * as deterministic tie-breakers, duplicates are dropped, the list is capped and
 * the source text is trimmed to the shared character budget exactly like the
 * server-side per-base result.
 */
export function mergeKnowledgeSearchResults(
  groups: KnowledgeSearchGroup[]
): KnowledgeSearchGroup {
  const hits = new Map<string, MessageKnowledgeResult>()
  const stale = new Map<string, KnowledgeStaleDocument>()
  for (const group of groups) {
    for (const hit of group.hits) {
      if (!hits.has(hit.chunkId)) {
        hits.set(hit.chunkId, hit)
      }
    }
    for (const document of group.staleDocuments) {
      if (!stale.has(document.id)) {
        stale.set(document.id, document)
      }
    }
  }

  const ordered = [...hits.values()].sort(compareKnowledgeHits)
  let budget = KNOWLEDGE_RETRIEVAL_CHAR_BUDGET
  const trimmed: MessageKnowledgeResult[] = []
  for (const hit of ordered) {
    if (trimmed.length >= KNOWLEDGE_RETRIEVAL_MAX_RESULTS || budget <= 0) break
    const characters = [...hit.text]
    if (characters.length > budget) {
      trimmed.push({
        ...hit,
        text: characters.slice(0, budget).join(''),
        truncated: true,
      })
      break
    }
    budget -= characters.length
    trimmed.push(hit)
  }

  return {
    hits: trimmed,
    staleDocuments: [...stale.values()].sort((left, right) => {
      if (left.filename !== right.filename) {
        return left.filename < right.filename ? -1 : 1
      }
      return left.id < right.id ? -1 : 1
    }),
  }
}

function compareKnowledgeHits(
  left: MessageKnowledgeResult,
  right: MessageKnowledgeResult
): number {
  if (left.score !== right.score) {
    return left.score > right.score ? -1 : 1
  }
  if (left.filename !== right.filename) {
    return left.filename < right.filename ? -1 : 1
  }
  if (left.chunkIndex !== right.chunkIndex) {
    return left.chunkIndex - right.chunkIndex
  }
  return left.chunkId < right.chunkId ? -1 : 1
}
