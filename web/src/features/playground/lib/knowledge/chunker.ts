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

/**
 * Deterministic UTF-8 chunking for the Playground knowledge indexer.
 *
 * The browser owns chunking because it also owns the embedding relay call: the
 * same text always produces the same indexes and the same slices, so reindexing
 * a document is a pure function of the extracted text. Chunks target one KiB,
 * carry a small overlap for retrieval context, and never split a Unicode code
 * point. The server independently validates the submitted text and embedding
 * sizes, so these are UX bounds rather than a security boundary.
 */
export const KNOWLEDGE_CHUNK_TARGET_BYTES = 1024
export const KNOWLEDGE_CHUNK_OVERLAP_BYTES = 128
export const KNOWLEDGE_CHUNK_MAX_BYTES = 4096
export const KNOWLEDGE_CHUNK_MAX_COUNT = 500

const BOUNDARY_WINDOW_BYTES = 256
const BOUNDARY_MIN_FRACTION = 0.6

export interface KnowledgeChunk {
  index: number
  text: string
}

export class KnowledgeChunkError extends Error {
  readonly code: 'too_many_chunks'

  constructor(code: 'too_many_chunks') {
    super(
      code === 'too_many_chunks'
        ? 'The document needs more chunks than the knowledge base allows.'
        : 'The document could not be split into knowledge chunks.'
    )
    this.name = 'KnowledgeChunkError'
    this.code = code
  }
}

interface CodePointIndex {
  /** UTF-16 index where each code point starts, plus the string length. */
  charStarts: number[]
  /** UTF-8 byte offset where each code point starts, plus the byte length. */
  byteStarts: number[]
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function indexCodePoints(text: string): CodePointIndex {
  const charStarts = [0]
  const byteStarts = [0]
  let bytes = 0
  let offset = 0
  while (offset < text.length) {
    const codePoint = text.codePointAt(offset)
    if (codePoint === undefined) break
    offset += codePoint > 0xffff ? 2 : 1
    bytes += utf8ByteLength(codePoint)
    charStarts.push(offset)
    byteStarts.push(bytes)
  }
  return { charStarts, byteStarts }
}

/** First code-point index whose byte offset reaches `goal`. */
function lowerBoundByte(byteStarts: number[], goal: number): number {
  let low = 1
  let high = byteStarts.length - 1
  let result = high
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (byteStarts[middle] >= goal) {
      result = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return result
}

/**
 * Rank a character as a preferred chunk boundary. Newlines beat sentence end
 * punctuation, which beats clause punctuation, which beats whitespace. A
 * boundary character belongs to the chunk it ends.
 */
function boundaryRank(character: string): number {
  if (character === '\n' || character === '\r') return 4
  if ('。！？.!?'.includes(character)) return 3
  if ('；;，,、'.includes(character)) return 2
  if (character === ' ' || character === '\t') return 1
  return 0
}

function chooseBoundaryEnd(
  text: string,
  index: CodePointIndex,
  start: number,
  candidate: number
): number {
  const minimumBytes =
    index.byteStarts[start] +
    Math.floor(KNOWLEDGE_CHUNK_TARGET_BYTES * BOUNDARY_MIN_FRACTION)
  const windowStartBytes = index.byteStarts[candidate] - BOUNDARY_WINDOW_BYTES
  let best = candidate
  let bestRank = 0
  for (let position = candidate; position > start; position -= 1) {
    if (index.byteStarts[position] < minimumBytes) break
    const character = text.slice(
      index.charStarts[position - 1],
      index.charStarts[position]
    )
    const rank = boundaryRank(character)
    if (rank > bestRank) {
      best = position
      bestRank = rank
      if (rank === 4) break
    }
    if (index.byteStarts[position] < windowStartBytes && bestRank > 0) break
  }
  return best
}

function overlapStart(
  byteStarts: number[],
  start: number,
  end: number
): number {
  const endBytes = byteStarts[end]
  let next = end
  while (
    next > start &&
    endBytes - byteStarts[next] < KNOWLEDGE_CHUNK_OVERLAP_BYTES
  ) {
    next -= 1
  }
  // A chunk shorter than the overlap policy starts the next chunk at its end,
  // otherwise the loop would never make progress.
  return next <= start ? end : next
}

/**
 * Split extracted document text into deterministic, overlap-aware chunks.
 * Leading and trailing whitespace around each chunk is removed so the server's
 * non-empty text check never sees a whitespace-only slice.
 */
export function chunkKnowledgeText(raw: string): KnowledgeChunk[] {
  const text = raw.trim()
  if (text === '') return []

  const index = indexCodePoints(text)
  const totalCodePoints = index.charStarts.length - 1
  const chunks: KnowledgeChunk[] = []
  let start = 0

  while (start < totalCodePoints) {
    const target = Math.min(
      KNOWLEDGE_CHUNK_TARGET_BYTES,
      KNOWLEDGE_CHUNK_MAX_BYTES
    )
    let candidate = lowerBoundByte(
      index.byteStarts,
      index.byteStarts[start] + target
    )
    if (candidate <= start) candidate = Math.min(totalCodePoints, start + 1)

    const end =
      candidate >= totalCodePoints
        ? totalCodePoints
        : chooseBoundaryEnd(text, index, start, candidate)
    const slice = text
      .slice(index.charStarts[start], index.charStarts[end])
      .trim()
    if (slice !== '') {
      if (chunks.length >= KNOWLEDGE_CHUNK_MAX_COUNT) {
        throw new KnowledgeChunkError('too_many_chunks')
      }
      chunks.push({ index: chunks.length, text: slice })
    }

    if (end >= totalCodePoints) break
    let next = overlapStart(index.byteStarts, start, end)
    if (next <= start) next = end
    start = next
  }

  return chunks
}
